import allFallback from "./_data/all.js";
import { sbSelect } from "./_lib/supabase.js";

const BASE = "https://toonkotsu-app.pages.dev";
const DISCOVER = ["new", "trending", "completed", "seasonal", "gems"];

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function onRequest(context) {
  const today = new Date().toISOString().slice(0, 10);
  let titles = [];
  if (context.env.SUPABASE_URL) {
    try {
      titles = await sbSelect(context.env, "manga", { columns: "code,slug", order: [["id", true]] });
    } catch {}
  }
  if (titles.length === 0) titles = allFallback.map((s) => ({ code: s.code, slug: s.slug }));
  const urls = [];
  urls.push(`<url><loc>${BASE}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`);
  for (const t of titles) {
    urls.push(`<url><loc>${esc(BASE)}/title/${esc(t.slug)}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  for (const d of DISCOVER) {
    urls.push(`<url><loc>${BASE}/discover/${d}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
