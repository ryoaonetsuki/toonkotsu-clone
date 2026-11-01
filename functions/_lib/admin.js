import { json, getSessionUser, canWrite, logAction, getSettings, seriesFromRow, slugify, chapterStats, sessionCookies, normalizeChapterLanguage, mangaTranslationLanguage } from "./db.js";
import { sbSelect, sbInsert, sbUpdate, sbDelete, sbUpsert, sbCount, sbAuthTokenSignIn, sbAuthAdminCreateUser, resolveEmail } from "./supabase.js";

function noDb() { return json({ error: "Database is not configured." }, 503); }
function needAuth() { return json({ error: "Please log in." }, 401); }
function forbidden() { return json({ error: "You do not have permission for this action." }, 403); }
function hasDb(env) { return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY); }

async function bodyJson(req) {
  try { return await req.json(); } catch { return {}; }
}

async function uploadToImgbb(env, fileBlob, filename) {
  const settings = await getSettings(env);
  const key = settings.imgbb_key || "";
  if (!key) return { error: "Image hosting is not configured. Open Settings and add your ImgBB API key." };
  const fd = new FormData();
  fd.append("key", key);
  fd.append("image", fileBlob, filename || "upload.jpg");
  const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: fd, signal: AbortSignal.timeout(30000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data || !data.data.url) {
    return { error: "Image upload failed. Please check the ImgBB API key in Settings and try again." };
  }
  return { url: data.data.url };
}

// ---- metadata fields shared by manual add, edit and import ----
const META_KEYS = ["author", "artist", "content_rating", "content_type", "alt_titles", "studio", "start_year", "rating", "translator"];
function metaFromBody(b) {
  const out = {};
  out.author = String(b.author || "").trim() || null;
  out.artist = String(b.artist || "").trim() || null;
  out.content_rating = String(b.content_rating || "").trim() || null;
  out.content_type = String(b.content_type || b.type || "").trim() || null;
  out.alt_titles = null;
  if (b.alt_titles !== undefined) {
    if (typeof b.alt_titles === "object" && b.alt_titles !== null) out.alt_titles = JSON.stringify(b.alt_titles);
    else if (typeof b.alt_titles === "string" && b.alt_titles.trim()) {
      try { JSON.parse(b.alt_titles); out.alt_titles = b.alt_titles; } catch { out.alt_titles = JSON.stringify({ en: b.alt_titles.split(",").map((s) => s.trim()).filter(Boolean) }); }
    } else out.alt_titles = null;
  }
  out.studio = String(b.studio || "").trim() || null;
  out.start_year = b.start_year !== undefined && b.start_year !== "" && b.start_year !== null ? Number(b.start_year) : null;
  out.rating = b.rating !== undefined && b.rating !== "" && b.rating !== null ? Number(b.rating) : null;
  out.translator = String(b.translator || "").trim() || null;
  return out;
}
function metaColumns() { return ["author", "artist", "content_rating", "content_type", "alt_titles", "studio", "start_year", "rating", "translator"]; }
function metaValues(m) { return [m.author, m.artist, m.content_rating, m.content_type, m.alt_titles, m.studio, m.start_year, m.rating, m.translator]; }

async function nextMangaId(env) {
  const rows = await sbSelect(env, "manga", { columns: "id", order: [["id", false]], limit: 1 });
  const max = rows.length ? Number(rows[0].id) : 900000;
  return Math.max(max + 1, 900001);
}
async function nextChapterId(env) {
  const rows = await sbSelect(env, "chapters", { columns: "id", order: [["id", false]], limit: 1 });
  return rows.length ? Number(rows[0].id) + 1 : 9000011;
}

export async function adminHandler(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const parts = (context.params.path || []).slice(1); // after "admin"
  const method = request.method;
  if (!hasDb(env)) return noDb();

  // ---- auth routes (Supabase Auth) ----
  if (parts[0] === "login" && method === "POST") {
    const body = await bodyJson(request);
    const email = String(body.identifier || body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) return json({ error: "Email and password are required." }, 400);
    let tokens;
    try {
      tokens = await sbAuthTokenSignIn(env, email, password);
    } catch (e) {
      return json({ error: "Invalid email or password." }, 401);
    }
    const profile = await sbSelect(env, "profiles", { columns: "*", eq: { id: tokens.user.id }, single: true }).catch(() => null);
    if (!profile) return json({ error: "Invalid email or password." }, 401);
    if (profile.banned) return json({ error: "This account is banned." }, 403);
    await logAction(env, profile.email, "Logged in");
    return json({ ok: true, user: { id: profile.id, email: profile.email, role: profile.role } }, 200, {
      setCookies: sessionCookies(tokens.access_token, tokens.refresh_token, 3600),
    });
  }
  if (parts[0] === "register" && method === "POST") {
    const body = await bodyJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "A valid email address is required." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const dup = await sbSelect(env, "profiles", { columns: "id", eq: { email }, single: true }).catch(() => null);
    if (dup) return json({ error: "An account with this email already exists. Please log in instead." }, 409);
    let created;
    try {
      created = await sbAuthAdminCreateUser(env, email, password, {});
    } catch (e) {
      if (String(e.message || "").toLowerCase().includes("already")) return json({ error: "An account with this email already exists. Please log in instead." }, 409);
      return json({ error: "Registration failed. Please try again." }, 500);
    }
    await sbInsert(env, "profiles", [{ id: created.id, email, role: "user", created_at: Date.now() }]).catch(() => {});
    await logAction(env, email, "Registered a new account");
    return json({ ok: true });
  }
  if (parts[0] === "logout" && method === "POST") {
    const user = await getSessionUser(env, request);
    if (user) await logAction(env, user.email, "Logged out");
    return json({ ok: true }, 200, { setCookies: sessionCookies(null, null, 0) });
  }

  const user = await getSessionUser(env, request);
  if (!user) return needAuth();
  const isAdmin = user.role === "admin";
  const isMod = user.role === "moderator";

  if (parts[0] === "me") return json({ user: { id: user.id, email: user.email, role: user.role } });

  // ---- manga ----
  if (parts[0] === "manga" && method === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "100", 10));
    let rows;
    if (q) {
      const all = await sbSelect(env, "manga", { columns: "*", order: [["id", true]] });
      rows = all.filter((r) => (r.title || "").toLowerCase().includes(q));
    } else {
      rows = await sbSelect(env, "manga", { columns: "*", order: [["id", true]], limit });
    }
    const stats = await chapterStats(env);
    const items = rows.map((row) => {
      const st = stats.get(row.id) || { count: 0, latest: null };
      return { ...seriesFromRow(row, st.count, st.latest), owner_id: row.owner_id, meta_title: row.meta_title, meta_description: row.meta_description };
    });
    return json({ items, total: items.length });
  }
  if (parts[0] === "manga" && method === "POST") {
    try {
    if (!isAdmin && !isMod) return forbidden();
    const b = await bodyJson(request);
    const title = String(b.title || "").trim();
    if (!title) return json({ error: "Title is required." }, 400);
    const all = await sbSelect(env, "manga", { columns: "id,title" });
    if (all.some((r) => (r.title || "").toLowerCase() === title.toLowerCase())) return json({ error: "A manga with this title already exists." }, 409);
    let slug = slugify(title);
    if (all.some((r) => r.slug === slug)) slug = slug + "-" + Date.now().toString().slice(-5);
    const tags = Array.isArray(b.tags) ? b.tags : (String(b.tags || "").split(",").map((s) => s.trim()).filter(Boolean));
    const meta = metaFromBody(b);
    const id = await nextMangaId(env);
    const row = {
      id, code: "y" + String(id), slug, title, cover: b.cover || "", banner: b.banner || null,
      description: b.description || null, meta_title: b.meta_title || title, meta_description: b.meta_description || null,
      status: b.status || "Ongoing", type: b.type || "Manhwa", score: Number(b.score) || 0, year: Number(b.year) || 2020,
      original_language: b.original_language || "ko", tags: JSON.stringify(tags), spotlight: false, owner_id: user.id, created_at: Date.now(),
    };
    metaColumns().forEach((k, i) => { row[k] = metaValues(meta)[i]; });
    await sbInsert(env, "manga", [row]);
    await logAction(env, user.email, `Added manga “${title}”`);
    return json({ ok: true, id, code: "y" + String(id) });
    } catch (err) {
      return json({ error: "Could not save manga. Please try again." }, 500);
    }
  }
  if (parts[0] === "manga" && parts[1] && method === "PUT") {
    const id = Number(parts[1]);
    const row = await sbSelect(env, "manga", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!row) return json({ error: "Manga not found." }, 404);
    if (!canWrite(user, row.owner_id)) return forbidden();
    const b = await bodyJson(request);
    if (b.title && b.title.trim().toLowerCase() !== row.title.toLowerCase()) {
      const all = await sbSelect(env, "manga", { columns: "id,title" });
      if (all.some((r) => r.id !== id && (r.title || "").toLowerCase() === b.title.trim().toLowerCase())) return json({ error: "A manga with this title already exists." }, 409);
    }
    const tags = b.tags !== undefined ? (Array.isArray(b.tags) ? b.tags : String(b.tags).split(",").map((s) => s.trim()).filter(Boolean)) : JSON.parse(row.tags || "[]");
    const meta = metaFromBody(b);
    const vals = {
      title: b.title !== undefined ? b.title : row.title,
      cover: b.cover !== undefined ? b.cover : row.cover,
      banner: b.banner !== undefined ? b.banner : row.banner,
      description: b.description !== undefined ? b.description : row.description,
      meta_title: b.meta_title !== undefined ? b.meta_title : row.meta_title,
      meta_description: b.meta_description !== undefined ? b.meta_description : row.meta_description,
      status: b.status !== undefined ? b.status : row.status,
      type: b.type !== undefined ? b.type : row.type,
      score: b.score !== undefined ? Number(b.score) : row.score,
      year: b.year !== undefined ? Number(b.year) : row.year,
      tags: JSON.stringify(tags),
    };
    if (META_KEYS.some((k) => b[k] !== undefined)) {
      vals.author = b.author !== undefined ? (String(b.author).trim() || null) : row.author;
      vals.artist = b.artist !== undefined ? (String(b.artist).trim() || null) : row.artist;
      vals.content_rating = b.content_rating !== undefined ? (String(b.content_rating).trim() || null) : row.content_rating;
      vals.content_type = b.content_type !== undefined ? (String(b.content_type).trim() || null) : row.content_type;
      vals.alt_titles = b.alt_titles !== undefined ? meta.alt_titles : row.alt_titles;
      vals.studio = b.studio !== undefined ? (String(b.studio).trim() || null) : row.studio;
      vals.start_year = b.start_year !== undefined ? meta.start_year : row.start_year;
      vals.rating = b.rating !== undefined ? meta.rating : row.rating;
      vals.translator = b.translator !== undefined ? (String(b.translator).trim() || null) : row.translator;
    }
    await sbUpdate(env, "manga", vals, { id });
    await logAction(env, user.email, `Edited manga “${row.title}”`);
    return json({ ok: true });
  }
  if (parts[0] === "manga" && parts[1] && method === "DELETE") {
    const id = Number(parts[1]);
    const row = await sbSelect(env, "manga", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!row) return json({ error: "Manga not found." }, 404);
    if (!canWrite(user, row.owner_id)) return forbidden();
    const chs = await sbSelect(env, "chapters", { columns: "id", eq: { manga_id: id } });
    for (const c of chs) await sbDelete(env, "chapter_pages", { chapter_id: c.id });
    await sbDelete(env, "chapters", { manga_id: id });
    await sbDelete(env, "manga", { id });
    await logAction(env, user.email, `Deleted manga “${row.title}”`);
    return json({ ok: true });
  }

  // ---- chapters ----
  if (parts[0] === "chapters" && method === "GET") {
    const mangaId = Number(url.searchParams.get("manga_id") || "0");
    const chs = await sbSelect(env, "chapters", { columns: "*", eq: { manga_id: mangaId }, order: [["n", true]] });
    const items = [];
    for (const c of chs) {
      const pages = await sbSelect(env, "chapter_pages", { columns: "*", eq: { chapter_id: c.id }, order: [["position", true]] });
      items.push({ id: c.id, manga_id: c.manga_id, n: c.n, label: c.label, owner_id: c.owner_id, language: normalizeChapterLanguage(c.language, "en"), pages: pages.map((p) => ({ id: p.id, src: p.src, position: p.position })) });
    }
    return json({ items });
  }
  if (parts[0] === "chapters" && !parts[1] && method === "POST") {
    if (!isAdmin && !isMod) return forbidden();
    const b = await bodyJson(request);
    const mangaId = Number(b.manga_id || "0");
    const m = await sbSelect(env, "manga", { columns: "*", eq: { id: mangaId }, single: true }).catch(() => null);
    if (!m) return json({ error: "Manga not found." }, 404);
    if (!canWrite(user, m.owner_id)) return forbidden();
    const n = Number(b.n || "0");
    if (!n) return json({ error: "Chapter number is required." }, 400);
    const dup = await sbSelect(env, "chapters", { columns: "id", eq: { manga_id: mangaId, n }, single: true }).catch(() => null);
    if (dup) return json({ error: "This chapter already exists for this manga." }, 409);
    const pages = Array.isArray(b.pages) ? b.pages : [];
    const cid = await nextChapterId(env);
    // Chapter flag: the translation language chosen on the Add Chapter form.
    // Default is the manga's translation language when one is set on its row,
    // otherwise English. Unknown values also fall back to English.
    const lang = normalizeChapterLanguage(b.language, mangaTranslationLanguage(m) || "en");
    // Stamp the real upload time so chapter rows show "uploaded X ago" from
    // when the chapter was actually added here, not a carried-over date.
    // If the chapters table has no language and/or created_at column, the
    // first insert fails and we fall back to narrower column sets, so
    // chapter creation itself never breaks (a chapter created without a
    // language column simply renders the default English flag).
    const baseRow = { id: cid, manga_id: mangaId, n, label: b.label || `Chapter ${n}`, owner_id: user.id };
    try {
      await sbInsert(env, "chapters", [{ ...baseRow, language: lang, created_at: Date.now() }]);
    } catch {
      try {
        await sbInsert(env, "chapters", [{ ...baseRow, created_at: Date.now() }]);
      } catch {
        await sbInsert(env, "chapters", [baseRow]);
      }
    }
    for (let i = 0; i < pages.length; i++) {
      await sbInsert(env, "chapter_pages", [{ chapter_id: cid, position: i + 1, src: String(pages[i]), w: 800, h: 1200 }], false);
    }
    await logAction(env, user.email, `Added Chapter ${n} to “${m.title}”`);
    return json({ ok: true, id: cid, language: lang });
  }
  if (parts[0] === "chapters" && parts[1] && method === "DELETE") {
    const id = Number(parts[1]);
    const c = await sbSelect(env, "chapters", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!c) return json({ error: "Chapter not found." }, 404);
    if (!canWrite(user, c.owner_id)) return forbidden();
    await sbDelete(env, "chapter_pages", { chapter_id: id });
    await sbDelete(env, "chapters", { id });
    await logAction(env, user.email, `Deleted Chapter ${c.n} (id ${id})`);
    return json({ ok: true });
  }
  if (parts[0] === "chapters" && parts[1] && parts[2] === "reorder" && method === "POST") {
    const id = Number(parts[1]);
    const c = await sbSelect(env, "chapters", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!c) return json({ error: "Chapter not found." }, 404);
    if (!canWrite(user, c.owner_id)) return forbidden();
    const b = await bodyJson(request);
    const order = Array.isArray(b.order) ? b.order : [];
    for (let i = 0; i < order.length; i++) {
      await sbUpdate(env, "chapter_pages", { position: i + 1 }, { id: Number(order[i]), chapter_id: id });
    }
    await logAction(env, user.email, `Reordered pages of Chapter ${c.n}`);
    return json({ ok: true });
  }

  // ---- image upload (ImgBB, server-side) ----
  if (parts[0] === "upload" && method === "POST") {
    if (!isAdmin && !isMod) return forbidden();
    let file = null, filename = "upload.jpg";
    try {
      const fd = await request.formData();
      file = fd.get("image");
      if (file && file.name) filename = file.name;
    } catch { return json({ error: "No image file received." }, 400); }
    if (!file) return json({ error: "No image file received." }, 400);
    const r = await uploadToImgbb(env, file, filename);
    if (r.error) return json({ error: r.error }, 400);
    return json({ ok: true, url: r.url });
  }

  // ---- Import (server uploads cover to ImgBB) ----
  if (parts[0] === "import" && method === "POST") {
    if (!isAdmin && !isMod) return forbidden();
    const b = await bodyJson(request);
    const title = String(b.title || "").trim();
    if (!title) return json({ error: "Title is required." }, 400);
    const all = await sbSelect(env, "manga", { columns: "id,title,slug" });
    if (all.some((r) => (r.title || "").toLowerCase() === title.toLowerCase())) return json({ error: "A manga with this title already exists." }, 409);
    let cover = "";
    if (b.cover) {
      const settings = await getSettings(env);
      if (!settings.imgbb_key) return json({ error: "Image hosting is not configured. Open Settings and add your ImgBB API key." }, 400);
      try {
        const imgRes = await fetch(b.cover, { headers: { "User-Agent": "BongManga/1.0" } });
        if (!imgRes.ok) throw new Error("cover fetch failed");
        const blob = await imgRes.blob();
        const up = await uploadToImgbb(env, blob, "cover.jpg");
        if (up.error) return json({ error: up.error }, 400);
        cover = up.url;
      } catch {
        return json({ error: "Could not fetch the cover image for upload. Please try again." }, 400);
      }
    }
    let slug = slugify(title);
    if (all.some((r) => r.slug === slug)) slug = slug + "-" + Date.now().toString().slice(-5);
    const tags = Array.isArray(b.genres) ? b.genres : [];
    const meta = metaFromBody(b);
    if (!meta.start_year && b.year) meta.start_year = Number(b.year);
    if (meta.rating === null && b.score) meta.rating = Number(b.score);
    const id = await nextMangaId(env);
    const row = {
      id, code: "y" + String(id), slug, title, cover, banner: null, description: b.synopsis || null,
      meta_title: title, meta_description: (b.synopsis || "").slice(0, 160) || null,
      status: b.status || "Ongoing", type: b.type || "Manga", score: Number(b.score) || 0, year: Number(b.year) || 2020,
      original_language: "ko", tags: JSON.stringify(tags), spotlight: false, owner_id: user.id, created_at: Date.now(),
    };
    metaColumns().forEach((k, i) => { row[k] = metaValues(meta)[i]; });
    await sbInsert(env, "manga", [row]);
    await logAction(env, user.email, `Imported manga “${title}”`);
    return json({ ok: true, id });
  }

  // ---- same-origin cover proxy (admin/mod only; search-result thumbnails) ----
  // Client networks sometimes cannot reach uploads.mangadex.org
  // directly, so their thumbnails load from the site's
  // own origin instead. Host allowlist only — never an open proxy.
  if (parts[0] === "cover-proxy" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    let target;
    try { target = new URL(url.searchParams.get("u") || ""); } catch { return json({ error: "Invalid image URL." }, 400); }
    if (target.protocol !== "https:" || (target.hostname !== "uploads.mangadex.org")) return json({ error: "Image host not allowed." }, 400);
    try {
      const up = await fetch(target.toString(), { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "BongManga/1.0", Accept: "image/*" } });
      if (!up.ok) return json({ error: "Cover image could not be fetched." }, 502);
      const buf = await up.arrayBuffer();
      return new Response(buf, { status: 200, headers: { "content-type": up.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400" } });
    } catch { return json({ error: "Cover image could not be fetched." }, 502); }
  }

  // ---- import search proxy (MangaDex only, server-side) ----
  if (parts[0] === "import-search" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const source = (url.searchParams.get("source") || "mangadex").toLowerCase();
    const mode = (url.searchParams.get("mode") || "title").toLowerCase();
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ error: "Search text is required." }, 400);
    const fetchJson = async (input, init) => {
      const res = await fetch(input, { ...(init || {}), signal: AbortSignal.timeout(20000), headers: { "User-Agent": "BongManga/1.0", Accept: "application/json", ...((init && init.headers) || {}) } });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    };
    const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const mapStatus = (s) => {
      const v = String(s || "").toLowerCase();
      if (v.includes("finish") || v === "completed") return "Complete";
      if (v.includes("hiatus")) return "Hiatus";
      return "Ongoing";
    };
    try {
      if (source === "mangadex") {
        const base = "https://api.mangadex.org/manga";
        const endpoint = mode === "id"
          ? `${base}/${encodeURIComponent(q)}?includes[]=cover_art&includes[]=author&includes[]=artist`
          : `${base}?title=${encodeURIComponent(q)}&limit=8&includes[]=cover_art&includes[]=author&includes[]=artist&order[followedCount]=desc`;
        const { res, data } = await fetchJson(endpoint);
        if (res.status === 429) return json({ error: "MangaDex is limiting requests right now. Please wait a minute and try again." }, 429);
        if (!res.ok) return json({ error: "No result found for this search." }, 502);
        const raw = mode === "id" ? (data.data ? [data.data] : []) : (data.data || []);
        const items = raw.map((it) => {
          const a = it.attributes || {};
          const rels = it.relationships || [];
          const coverRel = rels.find((r) => r.type === "cover_art");
          const cover = coverRel && coverRel.attributes && coverRel.attributes.fileName
            ? `https://uploads.mangadex.org/covers/${it.id}/${coverRel.attributes.fileName}.512.jpg` : "";
          const coverDisplay = cover ? `/api/admin/cover-proxy?u=${encodeURIComponent(cover)}` : "";
          const coverPlain = cover ? cover.replace(/\.512\.jpg$/, "") : "";
          const author = rels.filter((r) => r.type === "author").map((r) => r.attributes && r.attributes.name).filter(Boolean).join(", ");
          const artist = rels.filter((r) => r.type === "artist").map((r) => r.attributes && r.attributes.name).filter(Boolean).join(", ");
          const alt = {};
          for (const [lang, list] of Object.entries(a.altTitles || {})) {
            const vals = (Array.isArray(list) ? list : [list]).flatMap((o) => Object.values(o || {})).filter(Boolean);
            if (vals.length) alt[lang] = vals;
          }
          const lang = (a.originalLanguage || "ja").toLowerCase();
          const type = lang === "ko" ? "Manhwa" : lang === "zh" ? "Manhua" : "Manga";
          const ratingMap = { safe: "All Ages", suggestive: "16+", erotica: "18+", pornographic: "18+" };
          const mdTitles = a.title || {};
          const mdTitle = mdTitles.en || mdTitles.ja || mdTitles.ko || mdTitles.zh || Object.values(mdTitles)[0] || "";
          return {
            title: mdTitle,
            cover, cover_display: coverDisplay, cover_plain: coverPlain, synopsis: a.description ? (a.description.en || Object.values(a.description)[0] || "") : "",
            status: mapStatus(a.status), type, score: 0, year: a.year || 2020,
            genres: (a.tags || []).map((tg) => tg.attributes && tg.attributes.name && tg.attributes.name.en).filter(Boolean),
            author, artist, content_rating: ratingMap[a.contentRating] || "All Ages",
            alt_titles: alt, studio: "", start_year: a.year || null, source_id: it.id,
          };
        });
        return json({ items });
      }
      return json({ error: "Unknown import source." }, 400);
    } catch (err) {
      return json({ error: "The import source could not be reached from the server. Please try again in a minute." }, 502);
    }
  }

  // ---- ads placements (admin only for writes) ----
  if (parts[0] === "ads" && method === "GET") {
    if (!isAdmin) return forbidden();
    const rows = await sbSelect(env, "ads", { columns: "*", order: [["slot", true]] });
    return json({ items: rows });
  }
  if (parts[0] === "ads" && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    const slot = String(b.slot || "").trim();
    if (!slot) return json({ error: "Slot is required." }, 400);
    await sbUpsert(env, "ads", [{ slot, network: String(b.network || "Custom"), ad_type: String(b.ad_type || "Banner"), code: String(b.code || ""), enabled: b.enabled ? 1 : 0, updated_at: Date.now() }], "slot");
    await logAction(env, user.email, `Updated ad slot “${slot}”`);
    return json({ ok: true });
  }

  // ---- catalogue restore (admin only; symmetric with export) ----
  if (parts[0] === "restore" && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    const items = Array.isArray(b.items) ? b.items : [];
    let added = 0, skipped = 0;
    for (const it of items) {
      const title = String(it.title || "").trim();
      if (!title) { skipped++; continue; }
      const all = await sbSelect(env, "manga", { columns: "id,title,slug" });
      if (all.some((r) => (r.title || "").toLowerCase() === title.toLowerCase())) { skipped++; continue; }
      let slug = slugify(title);
      if (all.some((r) => r.slug === slug)) slug = slug + "-" + Date.now().toString().slice(-5);
      const tags = Array.isArray(it.tags) ? it.tags : (String(it.tags || "").split(",").map((x) => x.trim()).filter(Boolean));
      const id = await nextMangaId(env);
      await sbInsert(env, "manga", [{
        id, code: "y" + String(id), slug, title, cover: it.cover || "", banner: it.banner || null,
        description: it.description || null, meta_title: it.meta_title || title, meta_description: it.meta_description || null,
        status: it.status || "Ongoing", type: it.type || "Manhwa", score: Number(it.score) || 0, year: Number(it.year) || 2020,
        original_language: it.original_language || "ko", tags: JSON.stringify(tags), spotlight: false, owner_id: user.id, created_at: Date.now(),
      }]);
      added++;
    }
    await logAction(env, user.email, `Restored catalogue: ${added} added, ${skipped} skipped`);
    return json({ ok: true, added, skipped });
  }

  // ---- comments ----
  if (parts[0] === "comments" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const rows = await sbSelect(env, "comments", { columns: "*", order: [["id", false]], limit: 100 });
    return json({ items: rows });
  }
  if (parts[0] === "comments" && parts[1] && method === "POST") {
    if (!isAdmin && !isMod) return forbidden();
    const b = await bodyJson(request);
    const id = Number(parts[1]);
    const c = await sbSelect(env, "comments", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!c) return json({ error: "Comment not found." }, 404);
    if (b.action === "delete") {
      await sbDelete(env, "comments", { id });
    } else if (b.action === "approve" || b.action === "hide") {
      await sbUpdate(env, "comments", { status: b.action === "approve" ? "approved" : "hidden" }, { id });
    } else return json({ error: "Unknown action." }, 400);
    await logAction(env, user.email, `${b.action} comment ${id}`);
    return json({ ok: true });
  }

  // ---- reports ----
  if (parts[0] === "reports" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const rows = await sbSelect(env, "reports", { columns: "*", order: [["id", false]], limit: 100 });
    return json({ items: rows });
  }
  if (parts[0] === "reports" && parts[1] && parts[2] === "resolve" && method === "POST") {
    if (!isAdmin && !isMod) return forbidden();
    const id = Number(parts[1]);
    await sbUpdate(env, "reports", { status: "resolved" }, { id });
    await logAction(env, user.email, `Resolved report ${id}`);
    return json({ ok: true });
  }

  // ---- requests ----
  if (parts[0] === "requests" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const rows = await sbSelect(env, "requests", { columns: "*", order: [["id", false]], limit: 100 });
    return json({ items: rows });
  }
  if (parts[0] === "requests" && parts[1] && method === "POST") {
    if (!isAdmin && !isMod) return forbidden();
    const b = await bodyJson(request);
    const id = Number(parts[1]);
    const r = await sbSelect(env, "requests", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!r) return json({ error: "Request not found." }, 404);
    if (b.action !== "approve" && b.action !== "reject") return json({ error: "Unknown action." }, 400);
    await sbUpdate(env, "requests", { status: b.action === "approve" ? "approved" : "rejected" }, { id });
    await logAction(env, user.email, `${b.action} request “${r.title}”`);
    return json({ ok: true });
  }

  // ---- genres ----
  if (parts[0] === "genres" && method === "GET") {
    const rows = await sbSelect(env, "genres", { columns: "*", order: [["name", true]] });
    return json({ items: rows });
  }
  if (parts[0] === "genres" && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    const name = String(b.name || "").trim();
    if (!name) return json({ error: "Genre name is required." }, 400);
    const existing = await sbSelect(env, "genres", { columns: "id", eq: { name }, single: true }).catch(() => null);
    if (!existing) await sbInsert(env, "genres", [{ name }]);
    await logAction(env, user.email, `Added genre “${name}”`);
    return json({ ok: true });
  }
  if (parts[0] === "genres" && parts[1] && method === "DELETE") {
    if (!isAdmin) return forbidden();
    await sbDelete(env, "genres", { id: Number(parts[1]) });
    await logAction(env, user.email, `Deleted genre ${parts[1]}`);
    return json({ ok: true });
  }

  // ---- spotlight (admin only) ----
  if (parts[0] === "spotlight" && method === "GET") {
    const rows = await sbSelect(env, "manga", { columns: "*", eq: { spotlight: true }, order: [["id", true]] });
    const stats = await chapterStats(env);
    const items = rows.map((row) => {
      const st = stats.get(row.id) || { count: 0, latest: null };
      return seriesFromRow(row, st.count, st.latest);
    });
    return json({ items });
  }
  if (parts[0] === "spotlight" && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    const allIds = (await sbSelect(env, "manga", { columns: "id" })).map((r) => r.id);
    for (const mid of allIds) await sbUpdate(env, "manga", { spotlight: false }, { id: mid });
    if (Array.isArray(b.items)) {
      for (const it of b.items.slice(0, 5)) {
        const id = Number(it.id);
        if (!id) continue;
        const vals = { spotlight: true };
        if (it.banner !== undefined) vals.banner = String(it.banner || "") || null;
        await sbUpdate(env, "manga", vals, { id });
      }
      await logAction(env, user.email, "Updated Spotlight titles");
      return json({ ok: true });
    }
    const ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
    for (const id of ids.slice(0, 5)) await sbUpdate(env, "manga", { spotlight: true }, { id });
    await logAction(env, user.email, "Updated Spotlight titles");
    return json({ ok: true });
  }

  // ---- settings (admin only for writes) ----
  if (parts[0] === "settings" && method === "GET") {
    if (!isAdmin) return forbidden();
    const s = await getSettings(env);
    return json({ site_name: s.site_name || "", footer_text: s.footer_text || "", social_links: s.social_links || "{}", announcement: s.announcement || "", maintenance: s.maintenance || "0", show_adult: s.show_adult || "0", imgbb_configured: Boolean(s.imgbb_key), logo_url: s.logo_url || "" });
  }
  if (parts[0] === "settings" && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    const allowed = ["site_name", "footer_text", "social_links", "announcement", "maintenance", "show_adult", "logo_url"];
    for (const k of allowed) {
      if (b[k] !== undefined) await sbUpsert(env, "settings", [{ key: k, value: String(b[k]) }], "key");
    }
    if (b.imgbb_key) await sbUpsert(env, "settings", [{ key: "imgbb_key", value: String(b.imgbb_key) }], "key");
    await logAction(env, user.email, "Updated site settings");
    return json({ ok: true });
  }

  // ---- users (admin only) ----
  if (parts[0] === "users" && method === "GET") {
    if (!isAdmin) return forbidden();
    const rows = await sbSelect(env, "profiles", { columns: "id,email,role,banned,created_at", order: [["id", true]] });
    return json({ items: rows });
  }
  if (parts[0] === "users" && !parts[1] && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    const email = String(b.email || "").trim();
    const role = b.role === "moderator" ? "moderator" : "user";
    if (!email || !b.password) return json({ error: "Email and password are required." }, 400);
    try {
      const created = await sbAuthAdminCreateUser(env, email, String(b.password), {});
      await sbInsert(env, "profiles", [{ id: created.id, email, role, created_at: Date.now() }]);
    } catch { return json({ error: "A user with this email already exists." }, 409); }
    await logAction(env, user.email, `Created ${role} account ${email}`);
    return json({ ok: true });
  }
  if (parts[0] === "users" && parts[1] && method === "POST") {
    if (!isAdmin) return forbidden();
    const id = parts[1];
    const target = await sbSelect(env, "profiles", { columns: "*", eq: { id }, single: true }).catch(() => null);
    if (!target) return json({ error: "User not found." }, 404);
    if (target.role === "admin") return json({ error: "The admin account cannot be changed here." }, 403);
    const b = await bodyJson(request);
    if (b.action === "ban") await sbUpdate(env, "profiles", { banned: true }, { id });
    else if (b.action === "unban") await sbUpdate(env, "profiles", { banned: false }, { id });
    else if (b.action === "role" && (b.role === "moderator" || b.role === "user")) await sbUpdate(env, "profiles", { role: b.role }, { id });
    else return json({ error: "Unknown action." }, 400);
    await logAction(env, user.email, `${b.action} user ${target.email}`);
    return json({ ok: true });
  }

  // ---- activity / analytics / announcements / check-images / export ----
  if (parts[0] === "activity" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const rows = await sbSelect(env, "activity_log", { columns: "*", order: [["id", false]], limit: 100 });
    return json({ items: rows });
  }
  if (parts[0] === "analytics" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const mc = await sbCount(env, "manga");
    const cc = await sbCount(env, "chapters");
    const uc = await sbCount(env, "profiles");
    const top = await sbSelect(env, "manga", { columns: "id,title,score,cover", order: [["score", false]], limit: 5 });
    return json({ manga: mc, chapters: cc, users: uc, top: top.map((r) => ({ id: r.id, title: r.title, score: r.score, cover: r.cover })) });
  }
  if (parts[0] === "announcements" && method === "GET") {
    const s = await getSettings(env);
    return json({ announcement: s.announcement || "" });
  }
  if (parts[0] === "announcements" && method === "POST") {
    if (!isAdmin) return forbidden();
    const b = await bodyJson(request);
    await sbUpsert(env, "settings", [{ key: "announcement", value: String(b.announcement || "") }], "key");
    await logAction(env, user.email, "Updated the announcement");
    return json({ ok: true });
  }
  if (parts[0] === "check-images" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const rows = await sbSelect(env, "manga", { columns: "id,title,cover", order: [["id", true]] });
    const broken = [];
    const unchecked = [];
    for (let i = 0; i < rows.length; i += 8) {
      const batch = rows.slice(i, i + 8);
      await Promise.all(batch.map(async (r) => {
        try {
          const res = await fetch(r.cover, { method: "HEAD" });
          if (!res.ok) {
            const item = { id: r.id, title: r.title, cover: r.cover, status: res.status };
            if (res.status === 429 || res.status === 503) unchecked.push(item);
            else broken.push(item);
          }
        } catch { unchecked.push({ id: r.id, title: r.title, cover: r.cover, status: 0 }); }
      }));
    }
    return json({ checked: rows.length, broken, unchecked });
  }
  if (parts[0] === "export" && method === "GET") {
    if (!isAdmin && !isMod) return forbidden();
    const rows = await sbSelect(env, "manga", { columns: "*", order: [["id", true]] });
    return json({ items: rows });
  }

  return json({ error: "Not found." }, 404);
}
