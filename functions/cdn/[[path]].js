import homeFallback from "../_data/home.js";
import homeSfwFallback from "../_data/home-sfw1.js";
import latestFallback from "../_data/latest.js";
import latestSfwFallback from "../_data/latest-sfw1.js";
import facetsFallback from "../_data/facets.js";
import facetsSfwFallback from "../_data/facets-sfw1.js";
import rankingsFallback from "../_data/rankings-sfw0.js";
import allFallback from "../_data/all.js";
import seriesFallback from "../_data/series.js";
import { json, dbMangaList, dbMangaByCode, seriesFromRow, allChapters, pageCounts, normalizeChapterLanguage, realTimestamp } from "../_lib/db.js";
import { sbSelect } from "../_lib/supabase.js";

// A chapter's real "uploaded X ago" timestamp: its created_at when present
// (panel uploads stamp it at add time), otherwise the legacy fallback value
// so old seed rows keep their previous display instead of breaking.
function chapterAt(ch) {
  return realTimestamp(ch && ch.created_at) || 1793000000000;
}

// Uploader credit for feed cards — mirrors the title-page logic in
// dbMangaByCode: ONLY a genuine panel upload shows the uploader's display
// name; seed chapters keep their "Yae" scanlator-group credit. A chapter
// counts as a panel upload if it carries created_at (stamped at add time)
// or a matching "Added Chapter" activity-log entry.
function chapterGroup(ch, cover, owners, logMap, title) {
  const panel = Boolean(realTimestamp(ch.created_at)) || (logMap && logMap.has(`${ch.n}::${title}`));
  const name = panel && ch.owner_id ? owners.get(ch.owner_id) : null;
  return name ? { slug: "uploader", name, logo: cover } : { slug: "yae", name: "Yae", logo: cover };
}

function codeOf(raw, seriesByCode) {
  if (!raw) return null;
  const s = String(raw);
  if (seriesByCode[s]) return s;
  const code = s.split("-")[0];
  if (seriesByCode[code]) return code;
  return null;
}

function byLegacyOrder(seriesList, legacyList) {
  const byCode = new Map(seriesList.map((s) => [s.code, s]));
  const out = [];
  const seen = new Set();
  for (const item of legacyList) {
    const s = byCode.get(item.code);
    if (s) { out.push(s); seen.add(s.code); }
  }
  for (const s of seriesList) if (!seen.has(s.code)) out.push(s);
  return out;
}

function latestItems(seriesList, chaptersByManga) {
  return seriesList.map((s) => {
    const ch = chaptersByManga[s.id];
    return {
      chapter: ch ? { id: ch.id, n: ch.n, label: ch.label, vol: null, at: chapterAt(ch), pages: ch.pages, w: 800, f: "jpg", mb: 2.5, wm: 800, src: "yae", language: normalizeChapterLanguage(ch.language, "en"), group: { slug: "yae", name: "Yae", logo: s.cover } } : { id: 0, n: 0, label: "Chapter 0", vol: null, at: 1793000000000, pages: 0, w: 800, f: "jpg", mb: 2.5, wm: 800, src: "yae", language: "en", group: { slug: "yae", name: "Yae", logo: s.cover } },
      series: s,
    };
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const parts = context.params.path || [];
  if (parts[0] === "v1") {
    // --- Database-first reads; fall back to the bundled data only if the DB is unavailable or empty.
    let db = null;
    if (context.env.SUPABASE_URL) {
      try {
        const list = await dbMangaList(context.env);
        if (list.series.length > 0) db = list;
      } catch { db = null; }
    }
    const sfw = url.searchParams.get("sfw");
    if (parts[1] === "home") {
      if (!db) return json(sfw === "1" ? homeSfwFallback : homeFallback);
      const base = sfw === "1" ? homeSfwFallback : homeFallback;
      const series = db.series;
      const allCh = await allChapters(context.env);
      const pcMap = await pageCounts(context.env);
      const chaptersByManga = {};
      for (const ch of allCh) if (!chaptersByManga[ch.manga_id]) chaptersByManga[ch.manga_id] = { ...ch, pages: pcMap.get(ch.id) || 0 };
      const counts = { series: series.length, chapters: 0 };
      for (const s of series) counts.chapters += s.chapters || 0;
      const tagCounts = {};
      for (const s of series) for (const t of s.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
      const genres = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
      return json({
        version: base.version,
        counts,
        spotlight: byLegacyOrder(series.filter((s) => {
          const row = db.rows.find((r) => r.code === s.code);
          return row && Boolean(row.spotlight); // Supabase stores booleans, D1 stored 0/1
        }), base.spotlight),
        latest: byLegacyOrder(series, base.latest).slice(0, 30),
        popular: byLegacyOrder(series, base.popular).slice(0, 30),
        fresh: byLegacyOrder(series, base.fresh).slice(0, 30),
        completed: series.filter((s) => s.status === "Complete"),
        genres,
      });
    }
    if (parts[1] === "latest") {
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      if (page > 1) return json({ items: [], page, limit: 70, hasNextPage: false });
      if (!db) return json(sfw === "1" ? latestSfwFallback : latestFallback);
      const allCh2 = await allChapters(context.env);
      const pcMap2 = await pageCounts(context.env);
      const latestByManga = {};
      for (const ch of allCh2) if (!latestByManga[ch.manga_id]) latestByManga[ch.manga_id] = { ...ch, pages: pcMap2.get(ch.id) || 0 };
      // Display-only backfill, mirroring the title-page path: chapters
      // created before created_at stamping (e.g. the owner's recent
      // imports) have no usable created_at on the row, but the activity log
      // recorded "Added Chapter N to <title>" with its real timestamp. No
      // rows are rewritten — this only feeds the "X ago" label, so a manga
      // added minutes ago does not show "5d" here.
      const uploaderLogs = new Map();
      const owners = new Map();
      try {
        if (Object.values(latestByManga).some((ch) => ch.owner_id)) {
          const profs = await sbSelect(context.env, "profiles", { columns: "id,name,email" });
          for (const pr of profs) owners.set(pr.id, pr.name || (pr.email ? pr.email.split("@")[0] : null));
        }
      } catch {}
      try {
        const titleById = new Map(db.series.map((s) => [s.id, s.title]));
        const missing = Object.values(latestByManga).filter((ch) => !realTimestamp(ch.created_at));
        if (missing.length) {
          const logs = await sbSelect(context.env, "activity_log", { columns: "action,created_at", order: [["created_at", false]], limit: 1000 });
          const norm = (v) => String(v || "").replace(/[“”]/g, '"');
          const logMap = uploaderLogs;
          for (const l of logs) {
            const m = /^Added Chapter (\d+) to "(.+)"$/.exec(norm(l.action));
            if (m && !logMap.has(`${m[1]}::${m[2]}`)) logMap.set(`${m[1]}::${m[2]}`, l.created_at);
          }
          for (const ch of missing) {
            const hit = logMap.get(`${ch.n}::${titleById.get(ch.manga_id)}`);
            if (hit !== undefined && hit !== null && realTimestamp(hit)) ch.created_at = hit;
          }
        }
      } catch {}
      const items = [];
      for (const s of db.series) {
        const ch = latestByManga[s.id];
        // The chapter's REAL upload time — previously every chapter here
        // hardcoded at 1793000000000 (~Oct 27, 2026), which is why a manga
        // added minutes ago showed "5d" in Just dropped. Seed chapters
        // without created_at keep the legacy value via chapterAt().
        if (ch) items.push({ chapter: { id: ch.id, n: ch.n, label: ch.label, vol: null, at: chapterAt(ch), pages: ch.pages, w: 800, f: "jpg", mb: 2.5, wm: 800, src: "yae", language: normalizeChapterLanguage(ch.language, "en"), group: chapterGroup(ch, s.cover, owners, uploaderLogs, s.title) }, series: s });
      }
      // Newest first, so a just-added manga/chapter sorts first in Just
      // dropped; equal timestamps keep series order (stable sort).
      items.sort((a, b) => (b.chapter.at || 0) - (a.chapter.at || 0));
      return json({ items, page: 1, limit: 70, hasNextPage: false });
    }
    if (parts[1] === "facets") {
      if (!db) return json(sfw === "1" ? facetsSfwFallback : facetsFallback);
      const tagCounts = {};
      for (const s of db.series) for (const t of s.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
      return json({ genres: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) });
    }
    if (parts[1] === "browse" || parts[1] === "query") {
      const q = (url.searchParams.get("title") || url.searchParams.get("q") || url.searchParams.get("search") || "").toLowerCase();
      const limit = parseInt(url.searchParams.get("limit") || "24", 10);
      if (!db) {
        let items = allFallback;
        if (q) items = items.filter((s) => (s.title || "").toLowerCase().includes(q) || (s.slug || "").includes(q));
        return json({ items: items.slice(0, limit), page: 1, limit, total: items.length, hasNextPage: false });
      }
      let rows = db.rows;
      if (q) rows = rows.filter((r) => (r.title || "").toLowerCase().includes(q) || (r.slug || "").includes(q));
      const seriesByCode = new Map(db.series.map((s) => [s.code, s]));
      const items = rows.slice(0, limit).map((r) => seriesByCode.get(r.code)).filter(Boolean);
      return json({ items, page: 1, limit, total: rows.length, hasNextPage: false });
    }
    if (parts[1] === "search") {
      const q = (url.searchParams.get("q") || url.searchParams.get("title") || "").toLowerCase();
      const limit = parseInt(url.searchParams.get("limit") || "24", 10);
      if (!db) {
        const items = q ? allFallback.filter((s) => (s.title || "").toLowerCase().includes(q) || (s.slug || "").includes(q)) : [];
        return json({ items: items.slice(0, limit), page: 1, limit, total: items.length, hasNextPage: false });
      }
      const rows = q ? db.rows.filter((r) => (r.title || "").toLowerCase().includes(q) || (r.slug || "").includes(q)) : [];
      const seriesByCode = new Map(db.series.map((s) => [s.code, s]));
      const items = rows.slice(0, limit).map((r) => seriesByCode.get(r.code)).filter(Boolean);
      return json({ items, page: 1, limit, total: rows.length, hasNextPage: false });
    }
    if (parts[1] === "recommendations") {
      const sid = url.searchParams.get("seriesId");
      const limit = parseInt(url.searchParams.get("limit") || "18", 10);
      if (!db) {
        const code = codeOf(sid, seriesFallback);
        const items = (code ? seriesFallback[code].recs : allFallback.slice(0, 18));
        return json({ items: items.slice(0, limit), page: 1, limit, total: items.length, hasNextPage: false });
      }
      const seriesByCode = new Map(db.series.map((s) => [s.code, s]));
      const code = codeOf(sid, Object.fromEntries(db.series.map((s) => [s.code, true])));
      let items;
      if (code) {
        const self = seriesByCode.get(code);
        const selfTags = new Set(self.tags || []);
        items = db.series.filter((s) => s.code !== code && (s.tags || []).some((t) => selfTags.has(t)));
        if (items.length < 12) items = items.concat(db.series.filter((s) => s.code !== code && !items.includes(s)));
        items = items.slice(0, 18);
      } else items = db.series.slice(0, 18);
      return json({ items: items.slice(0, limit), page: 1, limit, total: items.length, hasNextPage: false });
    }
    if (parts[1] === "cards") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      if (!db) {
        const items = [];
        for (const id of ids) {
          const code = codeOf(id, seriesFallback);
          if (code) items.push(seriesFallback[code].series);
        }
        return json({ items, page: 1, limit: items.length, hasNextPage: false });
      }
      const seriesByCode = new Map(db.series.map((s) => [s.code, s]));
      const seriesById = new Map(db.series.map((s) => [String(s.id), s]));
      const items = [];
      for (const id of ids) {
        const s = seriesByCode.get(id) || seriesByCode.get(String(id).split("-")[0]) || seriesById.get(String(id));
        if (s) items.push(s);
      }
      return json({ items, page: 1, limit: items.length, hasNextPage: false });
    }
    if (parts[1] === "series") {
      if (db) {
        const found = await dbMangaByCode(context.env, parts[2]);
        if (!found) return json({ error: "Series not found" }, 404);
        if (parts[3] === "enrichment") return json({ series: found.series });
        if (parts[3] === "covers") {
          return json({ covers: [{ url: found.series.cover, src: found.series.cover }], items: [{ url: found.series.cover, src: found.series.cover }] });
        }
        const selfTags = new Set(found.series.tags || []);
        let recs = db.series.filter((s) => s.code !== found.series.code && (s.tags || []).some((t) => selfTags.has(t))).slice(0, 12);
        if (recs.length < 12) recs = recs.concat(db.series.filter((s) => s.code !== found.series.code && !recs.includes(s)).slice(0, 12 - recs.length));
        return json({ series: found.series, chapters: found.chapters, recs });
      }
      const code = codeOf(parts[2], seriesFallback);
      if (!code) return json({ error: "Series not found" }, 404);
      if (parts[3] === "enrichment") return json({ series: seriesFallback[code].series });
      if (parts[3] === "covers") {
        const cover = seriesFallback[code].series.cover;
        return json({ covers: [{ url: cover, src: cover }], items: [{ url: cover, src: cover }] });
      }
      return json(seriesFallback[code]);
    }
    if (parts[1] === "landing") {
      const items = db ? db.series.slice(0, 24) : allFallback.slice(0, 24);
      return json({ items, page: 1, limit: 24, hasNextPage: false });
    }
    if (parts[1] === "groups" || parts[1] === "authors") {
      // No scanlator-group / author entities exist in this site's data
      // (chapter rows only carry a display default), so the honest list
      // state is empty — but it must be valid JSON with the total/pages
      // fields the pages read, never the SPA shell HTML.
      if (parts[2]) {
        if (parts[3] === "releases") return json({ items: [], pages: 1, page: 1, total: 0 });
        return json({ error: "Group not found" }, 404);
      }
      return json({ items: [], page: 1, limit: 50, hasNextPage: false, total: 0, pages: 1 });
    }
  }
  return context.env.ASSETS.fetch(context.request);
}
