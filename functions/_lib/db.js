import {
  sbSelect, sbInsert, sbUpdate, sbDelete, sbCount, sbUpsert,
  sbAuthGetUser, sbAuthRefresh, parseCookies,
} from "./supabase.js";

export function json(data, status = 200, extra = {}) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const [k, v] of Object.entries(extra)) {
    if (k === "setCookies") {
      for (const c of v) headers.append("Set-Cookie", c);
    } else headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export { parseCookies };

// Session lifetime, owner order 2026-11-01: stay logged in 3 days.
// (The old 1-hour session cookie logged the admin out on every return visit.)
export const SESSION_MAX_AGE_SEC = 3 * 86400;
export const REFRESH_MAX_AGE_SEC = 7 * 86400;

export function sessionCookies(accessToken, refreshToken, maxAgeSec) {
  const base = "Path=/; HttpOnly; SameSite=Lax; Secure";
  if (!accessToken) return ["tk_session=; " + base + "; Max-Age=0", "tk_refresh=; " + base + "; Max-Age=0"];
  return [
    "tk_session=" + accessToken + "; " + base + "; Max-Age=" + maxAgeSec,
    "tk_refresh=" + (refreshToken || "") + "; " + base + "; Max-Age=" + REFRESH_MAX_AGE_SEC,
  ];
}

// Session user via Supabase Auth JWT in the tk_session cookie. Refreshes with
// tk_refresh when the access token expired. Returns profile-shaped user or null.
export async function getSessionUser(env, req) {
  if (!env.SUPABASE_URL) return null;
  const cookies = parseCookies(req);
  let access = cookies.tk_session;
  // No session cookie (e.g. it expired) is NOT an immediate logout: if a
  // refresh token survives, rescue the session from it instead.
  let authUser = access ? await sbAuthGetUser(env, access).catch(() => null) : null;
  if (!authUser && cookies.tk_refresh) {
    const refreshed = await sbAuthRefresh(env, cookies.tk_refresh).catch(() => null);
    if (refreshed && refreshed.access_token) {
      access = refreshed.access_token;
      authUser = await sbAuthGetUser(env, access).catch(() => null);
      // Persisted by the onRequest wrappers via persistRefreshedSession():
      // Supabase rotates refresh tokens, so a refresh that is never written
      // back as a cookie breaks the NEXT request's refresh.
      req.__refreshed = refreshed;
    }
  }
  if (!authUser) return null;
  try {
    const profile = await sbSelect(env, "profiles", { columns: "*", eq: { id: authUser.id }, single: true });
    const avatar = (authUser.user_metadata && authUser.user_metadata.avatar_url) || null;
    if (!profile) return { id: authUser.id, email: authUser.email, role: "user", banned: false, name: null, avatar };
    if (profile.banned) return null;
    return { id: profile.id, email: profile.email, name: profile.name || null, role: profile.role, banned: !!profile.banned, avatar };
  } catch {
    return null;
  }
}

// Router-level rotation persistence, called once by each onRequest wrapper:
// if getSessionUser refreshed tokens during this request, write them back as
// cookies so the next request can use them. Never resurrects a session the
// handler just cleared (logout responses are returned untouched).
export function persistRefreshedSession(req, res) {
  const refreshed = req && req.__refreshed;
  if (!refreshed || !refreshed.access_token || !res || !res.headers) return res;
  let existing = [];
  if (typeof res.headers.getSetCookie === "function") existing = res.headers.getSetCookie();
  else { const c = res.headers.get("set-cookie") || ""; if (c) existing = [c]; }
  if (existing.some((c) => c.indexOf("tk_session=;") === 0)) return res;
  const oldRefresh = parseCookies(req).tk_refresh || "";
  const out = new Response(res.body, res);
  for (const c of sessionCookies(refreshed.access_token, refreshed.refresh_token || oldRefresh, SESSION_MAX_AGE_SEC)) out.headers.append("Set-Cookie", c);
  return out;
}

export function canWrite(user, ownerId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (user.role === "moderator") return ownerId === user.id;
  return false;
}

export async function logAction(env, email, action) {
  try {
    await sbInsert(env, "activity_log", [{ actor_email: email, action, created_at: Date.now() }], false);
  } catch {}
}

export async function getSettings(env) {
  const out = {};
  try {
    const rows = await sbSelect(env, "settings", { columns: "key,value" });
    for (const row of rows) out[row.key] = row.value;
  } catch {}
  return out;
}

// Upload a register-page profile picture (base64 data URL from the file
// picker) to ImgBB server-side with the key from Settings — the key is
// never shipped to clients, and no URL paste is accepted. Returns
// { url } or { error }. Used by both register handlers.
export async function uploadAvatarDataUrl(env, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) return { error: "The profile picture must be a JPEG, PNG, WebP or GIF image." };
  const mime = m[1];
  const b64 = m[2].replace(/\s/g, "");
  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { error: "The profile picture could not be read." };
  }
  if (bytes.length > 2 * 1024 * 1024) return { error: "The profile picture must be 2 MB or smaller." };
  const st = await getSettings(env);
  const key = st.imgbb_key || "";
  if (!key) return { error: "Profile picture upload is not configured yet. You can register without a picture and add one later." };
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
  const fd = new FormData();
  fd.append("key", key);
  fd.append("image", new Blob([bytes], { type: mime }), `avatar.${ext}`);
  let res, data;
  try {
    res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: fd });
    data = await res.json().catch(() => ({}));
  } catch {
    return { error: "Profile picture upload failed. Please try again." };
  }
  if (!res.ok || !data.data || !data.data.url) return { error: "Profile picture upload failed. Please check the picture and try again." };
  return { url: data.data.url };
}

// Banner files: the five spotlight banners, keyed by their hosted URL so the
// API can serve the same-origin local file first and keep the hosted URL as fallback.
// Template: no seed banner files ship with this template.
const BANNER_MAP = {};

// Local chapter page files in reading order (numeric order). Chapter 1 skips
// image 2 and chapter 4 skips image 12 because those files do not exist.
// Template: no seed chapter files ship with this template.
const LOCAL_CHAPTER_FILES = {};

export function localChapterPages(chapterN, pages) {
  const files = LOCAL_CHAPTER_FILES[chapterN];
  if (!files) return pages;
  return (pages || []).map((pg, i) => {
    const src = String(pg.src || "");
    if (/yae-v6-ch\d+-/.test(src) && i < files.length) {
      return { ...pg, src: `/yae/chapters/ch${chapterN}/${files[i]}.jpg`, fallback: src };
    }
    return pg;
  });
}

const PALETTE = ["#e47828", "#c084fc", "#38bdf8", "#f472b6", "#4ade80", "#facc15", "#fb923c", "#a78bfa"];

// A row's real timestamp (admin inserts stamp created_at as Date.now()).
// Accepts epoch ms, epoch seconds, or an ISO string; returns null when the
// value is missing or unparseable so callers can fall back.
export function realTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  if (ms > 0 && ms < 100000000000) return ms * 1000; // epoch seconds
  return ms;
}

export function seriesFromRow(row, chaptersCount, latest) {
  let tags = [];
  try { tags = JSON.parse(row.tags || "[]"); } catch {}
  if (!Array.isArray(tags)) tags = [];
  const idx = row.id >= 900001 ? row.id - 900000 : 1;
  // "Added X ago" must be the manga's REAL add time: admin-added rows carry
  // created_at (stamped at add time), so use it whenever present — a manga
  // added minutes ago shows "just now"/minutes ago and sorts first in Just
  // dropped. Only old seed rows with no created_at keep the old computed
  // value (their history is not rewritten).
  const fallbackAddedAt = 1700010000000 + (row.id % 1000) * 1000000;
  const addedAt = realTimestamp(row.created_at) || fallbackAddedAt;
  return {
    id: row.id,
    hid: "ye" + String(idx).padStart(3, "0"),
    code: row.code,
    slug: row.slug,
    title: row.title,
    cover: row.cover,
    banner: (row.banner && BANNER_MAP[row.banner]) || row.banner || undefined,
    bannerFallback: row.banner || undefined,
    description: row.description || undefined,
    color: PALETTE[(row.id || 1) % PALETTE.length],
    type: row.type || "Manhwa",
    originalLanguage: row.original_language || "ko",
    status: row.status || "Ongoing",
    year: row.year || 2020,
    addedAt,
    serializationStart: (row.year || 2020) + "-01-15",
    tags,
    spoilerTags: [],
    score: row.score || 0,
    adult: false,
    chapters: chaptersCount,
    count: chaptersCount,
    latest: latest ? { id: latest.id, n: latest.n, label: latest.label } : { id: 0, n: 0, label: "Chapter 0" },
    titles: [row.title],
    sourceKeys: ["yae"],
    author: row.author || undefined,
    artist: row.artist || undefined,
    authors: row.author ? [row.author] : [],
    artists: row.artist ? [row.artist] : [],
    content_rating: row.content_rating || undefined,
    content_type: row.content_type || row.type || "Manhwa",
    alt_titles: (() => { try { const v = JSON.parse(row.alt_titles || "null"); return v && typeof v === "object" ? v : undefined; } catch { return undefined; } })(),
    studio: row.studio || undefined,
    start_year: row.start_year || row.year || undefined,
    rating: row.rating || row.score || undefined,
    translator: row.translator || undefined,
  };
}

export async function chapterStats(env) {
  const chs = await sbSelect(env, "chapters", { columns: "manga_id,id,n,label", order: [["manga_id", true], ["n", true]] });
  const byManga = new Map();
  for (const c of chs) {
    let st = byManga.get(c.manga_id);
    if (!st) { st = { count: 0, latest: null }; byManga.set(c.manga_id, st); }
    st.count++;
    st.latest = { id: c.id, n: c.n, label: c.label };
  }
  return byManga;
}

export async function allChapters(env) {
  // created_at is stamped on new chapters only, and language is set on
  // chapters created via the panel language dropdown; if either column does
  // not exist yet, fall back to narrower selects so feeds never break.
  try {
    return await sbSelect(env, "chapters", { columns: "manga_id,id,n,label,created_at,language,owner_id", order: [["manga_id", true], ["n", false]] });
  } catch {
    try {
      return await sbSelect(env, "chapters", { columns: "manga_id,id,n,label,created_at,owner_id", order: [["manga_id", true], ["n", false]] });
    } catch {
      return sbSelect(env, "chapters", { columns: "manga_id,id,n,label,owner_id", order: [["manga_id", true], ["n", false]] });
    }
  }
}

export async function pageCounts(env) {
  const pages = await sbSelect(env, "chapter_pages", { columns: "chapter_id" });
  const map = new Map();
  for (const p of pages) map.set(p.chapter_id, (map.get(p.chapter_id) || 0) + 1);
  return map;
}

// Average LIVE user-review rating per manga (1..10 scale), from the reviews
// table when it exists. Only live reviews count: a review soft-deleted via
// review.delete (status "deleted") must stop contributing the moment it is
// deleted, otherwise a deleted review's rating lingers on the title header
// even though the Reviews section already shows 0 ratings. This mirrors the
// community endpoint's live filter exactly (approved / published / unset).
export function isLiveReviewStatus(status) {
  return status === "approved" || status === "published" || !status;
}
export async function reviewScoreMap(env) {
  const map = new Map();
  try {
    const rows = await sbSelect(env, "reviews", { columns: "manga_id,rating,status", limit: 5000 });
    const acc = new Map();
    for (const r of rows) {
      if (!isLiveReviewStatus(r.status)) continue;
      const mid = Number(r.manga_id);
      const rt = Number(r.rating);
      if (!mid || !Number.isFinite(rt)) continue;
      let a = acc.get(mid);
      if (!a) { a = { sum: 0, n: 0 }; acc.set(mid, a); }
      a.sum += rt; a.n++;
    }
    for (const [mid, a] of acc) if (a.n > 0) map.set(mid, Math.round((a.sum / a.n) * 10) / 10);
  } catch {}
  return map;
}
// Count of LIVE reviews per manga (same live filter as reviewScoreMap).
// Used by the title page so a title with zero live reviews shows the honest
// no-rating state even if a stale stored score or a deleted review exists.
export async function reviewLiveCountMap(env) {
  const map = new Map();
  try {
    const rows = await sbSelect(env, "reviews", { columns: "manga_id,status", limit: 5000 });
    for (const r of rows) {
      if (!isLiveReviewStatus(r.status)) continue;
      const mid = Number(r.manga_id);
      if (!mid) continue;
      map.set(mid, (map.get(mid) || 0) + 1);
    }
  } catch {}
  return map;
}

export async function dbMangaList(env) {
  const rows = await sbSelect(env, "manga", { columns: "*", order: [["id", true]] });
  const stats = await chapterStats(env);
  const series = rows.map((row) => {
    const st = stats.get(row.id) || { count: 0, latest: null };
    return seriesFromRow(row, st.count, st.latest);
  });
  const scores = await reviewScoreMap(env);
  for (const s of series) {
    const avg = scores.get(s.id);
    if (avg !== undefined) { s.score = avg; s.rating = avg; }
  }
  return { rows, series };
}

export async function dbMangaByCode(env, codeOrId) {
  if (!codeOrId) return null;
  const raw = String(codeOrId);
  // Lookup order (clean slug first, prefixed forms as safety nets — no link
  // form may 404 on a title that exists):
  //   1. code = raw (seed codes like y00071, admin codes like y900062)
  //   2. numeric raw = id
  //   3. slug = raw (clean slug URLs, e.g. /title/solo-leveling-arise)
  //   4. leading y<digits>- segment stripped -> slug (old prefixed URLs)
  //   5. legacy ye<digits> hid -> id 900000+n
  //   6. leading y<digits> (6+ digits, admin code) -> numeric id
  //   7. slug = raw minus a leading id-like first segment (last resort)
  const stripPrefixed = (v) => {
    const m = /^y\d{5,}-(.+)$/.exec(v) || /^ye\d+-(.+)$/.exec(v);
    return m ? m[1] : null;
  };
  const stripped = stripPrefixed(raw);
  const hidPart = raw.split("-")[0];
  const hidMatch = /^ye(\d+)$/.exec(hidPart);
  const adminCodeMatch = /^y(\d{6,})$/.exec(raw);
  let row = await sbSelect(env, "manga", { columns: "*", eq: { code: raw }, single: true }).catch(() => null);
  if (!row && /^\d+$/.test(raw)) {
    row = await sbSelect(env, "manga", { columns: "*", eq: { id: Number(raw) }, single: true }).catch(() => null);
  }
  if (!row) {
    row = await sbSelect(env, "manga", { columns: "*", eq: { slug: raw }, single: true }).catch(() => null);
  }
  if (!row && stripped) {
    row = await sbSelect(env, "manga", { columns: "*", eq: { slug: stripped }, single: true }).catch(() => null);
  }
  if (!row && hidMatch) {
    row = await sbSelect(env, "manga", { columns: "*", eq: { id: 900000 + Number(hidMatch[1]) }, single: true }).catch(() => null);
  }
  if (!row && adminCodeMatch) {
    row = await sbSelect(env, "manga", { columns: "*", eq: { id: Number(adminCodeMatch[1]) }, single: true }).catch(() => null);
  }
  if (!row && stripped !== raw) {
    const minusFirst = raw.includes("-") ? raw.slice(raw.indexOf("-") + 1) : null;
    if (minusFirst) {
      row = await sbSelect(env, "manga", { columns: "*", eq: { slug: minusFirst }, single: true }).catch(() => null);
    }
  }
  if (!row) return null;
  const chs = await sbSelect(env, "chapters", { columns: "*", eq: { manga_id: row.id }, order: [["n", true]] });
  const counts = await pageCounts(env);
  // Uploader credit: ONLY chapters that are genuinely panel uploads show the
  // uploader's display name (profile name, falling back to the email prefix).
  // A chapter counts as a panel upload if it carries created_at (stamped at
  // add time since 2026-11-01) or a matching "Added Chapter" activity-log
  // entry. Seed chapters keep their original "Yae" scanlator-group credit
  // untouched — even though the migration stamped them with an owner_id,
  // that stamp is not a panel upload and must not relabel old rows.
  const owners = new Map();
  const hasOwner = chs.some((c) => c.owner_id);
  if (hasOwner) {
    try {
      const profs = await sbSelect(env, "profiles", { columns: "id,name,email" });
      for (const p of profs) owners.set(p.id, p.name || (p.email ? p.email.split("@")[0] : null));
    } catch {}
  }
  const chapterAt = (c) => {
    // The "uploaded X ago" label must be the real upload time. New chapters
    // stamp created_at at add time; seed rows have none and keep the old
    // historical formula (their history is not rewritten).
    if (c.created_at !== undefined && c.created_at !== null) {
      const ms = typeof c.created_at === "number" ? c.created_at : Date.parse(c.created_at);
      if (Number.isFinite(ms)) return ms;
    }
    return 1700011000000 + c.n * 1000000;
  };
  // Display-only backfill for chapters uploaded before created_at stamping
  // existed (e.g. the owner's recent uploads): the activity log recorded
  // "Added Chapter N to <title>" with its real timestamp. No rows are
  // rewritten — this only feeds the label (and the uploader-credit check).
  const logMap = new Map();
  const missingAt = chs.filter((c) => !(c.created_at !== undefined && c.created_at !== null && Number.isFinite(typeof c.created_at === "number" ? c.created_at : Date.parse(c.created_at))));
  if (missingAt.length || hasOwner) {
    try {
      const logs = await sbSelect(env, "activity_log", { columns: "action,created_at", order: [["created_at", false]], limit: 1000 });
      const norm = (v) => String(v || "").replace(/[“”]/g, '"');
      for (const l of logs) {
        const m = /^Added Chapter (\d+) to "(.+)"$/.exec(norm(l.action));
        if (m && !logMap.has(`${m[1]}::${m[2]}`)) logMap.set(`${m[1]}::${m[2]}`, l.created_at);
      }
      for (const c of missingAt) {
        const hit = logMap.get(`${c.n}::${row.title}`);
        if (hit !== undefined && hit !== null) {
          const ms = typeof hit === "number" ? hit : Date.parse(hit);
          if (Number.isFinite(ms)) c.created_at = ms;
        }
      }
    } catch {}
  }
  const isPanelUpload = (c) => {
    if (c.created_at !== undefined && c.created_at !== null && Number.isFinite(typeof c.created_at === "number" ? c.created_at : Date.parse(c.created_at))) return true;
    return logMap.has(`${c.n}::${row.title}`);
  };
  const chapters = chs.map((c) => {
    const ownerName = c.owner_id && isPanelUpload(c) ? owners.get(c.owner_id) : null;
    // Chapter flag: the stored translation language; seed/legacy rows with
    // no language value keep the English flag (their stored rows are never
    // rewritten). The frontend renders this via its existing fi fi-<code>
    // mapping (en->gb, bn->bd, hi->in, ko->kr, ja->jp, zh->cn).
    return { id: c.id, n: c.n, label: c.label, vol: null, at: chapterAt(c), pages: counts.get(c.id) || 0, w: 800, f: "jpg", mb: 2.5, wm: 800, src: "yae", language: normalizeChapterLanguage(c.language, "en"), group: ownerName ? { slug: "uploader", name: ownerName, logo: row.cover } : { slug: "yae", name: "Yae", logo: row.cover } };
  });
  const cnt = chapters.length;
  const latest = chapters.length ? chapters[chapters.length - 1] : null;
  const series = seriesFromRow(row, cnt, latest);
  // Header rating follows LIVE user reviews only. Zero live reviews means
  // the honest no-rating state (N/A) even if the stored score is stale or
  // a deleted review once contributed — deleting the last review must clear
  // the header, not leave its rating behind.
  const scores = await reviewScoreMap(env);
  const liveCounts = await reviewLiveCountMap(env);
  const avg = scores.get(row.id);
  if ((liveCounts.get(row.id) || 0) === 0) {
    series.score = 0;
    series.rating = undefined;
  } else if (avg !== undefined) {
    series.score = avg;
    series.rating = avg;
  }
  return { row, series, chapters };
}

export async function dbChapter(env, chapterId) {
  const ch = await sbSelect(env, "chapters", { columns: "*", eq: { id: chapterId }, single: true }).catch(() => null);
  if (!ch) return null;
  const m = await sbSelect(env, "manga", { columns: "*", eq: { id: ch.manga_id }, single: true }).catch(() => null);
  if (!m) return null;
  const pages = await sbSelect(env, "chapter_pages", { columns: "*", eq: { chapter_id: ch.id }, order: [["position", true]] });
  const allCh = await sbSelect(env, "chapters", { columns: "id,n,label", eq: { manga_id: m.id }, order: [["n", true]] });
  const latest = allCh.length ? allCh[allCh.length - 1] : null;
  return {
    chapter: { id: ch.id, n: ch.n, label: ch.label, src: "yae", language: normalizeChapterLanguage(ch.language, "en"), pages: localChapterPages(ch.n, pages.map((p) => ({ src: p.src, w: p.w || 800, h: p.h || 1200 }))) },
    series: seriesFromRow(m, allCh.length, latest),
  };
}

// Chapter translation language (the flag shown in front of a chapter row).
// Stored on chapters.language as a short code. The frontend flag renderer
// already maps these codes to flag icons (en->gb, bn->bd, hi->in, ko->kr,
// ja->jp, zh->cn), so no new flag system is needed. Accepts codes, full
// language names, and flag codes defensively; anything unknown falls back.
const CHAPTER_LANGUAGES = ["en", "bn", "hi", "ko", "ja", "zh"];
const CHAPTER_LANGUAGE_ALIASES = {
  english: "en", gb: "en", uk: "en",
  bangla: "bn", bengali: "bn", bd: "bn",
  hindi: "hi", in: "hi",
  korean: "ko", kr: "ko",
  japanese: "ja", jp: "ja",
  chinese: "zh", cn: "zh", mandarin: "zh",
};
export function normalizeChapterLanguage(value, fallback = "en") {
  const v = String(value || "").trim().toLowerCase();
  if (CHAPTER_LANGUAGES.includes(v)) return v;
  if (CHAPTER_LANGUAGE_ALIASES[v]) return CHAPTER_LANGUAGE_ALIASES[v];
  const fb = String(fallback || "").trim().toLowerCase();
  if (CHAPTER_LANGUAGES.includes(fb)) return fb;
  if (CHAPTER_LANGUAGE_ALIASES[fb]) return CHAPTER_LANGUAGE_ALIASES[fb];
  return "en";
}
// A manga's translation language, if one is set on its row (checked fields
// in order); null when none is set, so callers fall back to English.
export function mangaTranslationLanguage(row) {
  if (!row) return null;
  const v = String(row.translated_language || row.translation_language || row.language || "").trim().toLowerCase();
  if (!v) return null;
  if (CHAPTER_LANGUAGES.includes(v)) return v;
  if (CHAPTER_LANGUAGE_ALIASES[v]) return CHAPTER_LANGUAGE_ALIASES[v];
  return null;
}

export function slugify(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";
}
