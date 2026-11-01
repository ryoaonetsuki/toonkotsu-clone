// Clean reader URLs (2026-11-01): the reader's canonical visible URL is
// /title/<slug>/chapter-<n>[/<page>]. A direct load of the old numeric
// reader URL /chapter/<id>[/<page>] 301s to its clean equivalent so
// bookmarks keep working; anything else serves the SPA shell.
import { dbChapter, slugify } from "../_lib/db.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const parts = context.params.path || [];
  const id = parts[0] || "";
  if (/^\d+$/.test(id) && context.env.SUPABASE_URL) {
    try {
      const entry = await dbChapter(context.env, Number(id));
      if (entry && entry.series && entry.chapter) {
        const slug = entry.series.slug || slugify(entry.series.title);
        const page = /^\d+$/.test(parts[1] || "") ? `/${parts[1]}` : "";
        return new Response(null, {
          status: 301,
          headers: { location: `/title/${slug}/chapter-${entry.chapter.n}${page}${url.search}`, "cache-control": "no-store" },
        });
      }
    } catch {}
  }
  const shell = await context.env.ASSETS.fetch(new Request(new URL("/", context.request.url), context.request));
  return new Response(shell.body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
