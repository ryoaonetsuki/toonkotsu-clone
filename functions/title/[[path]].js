// Clean title URLs (2026-11-01): title links are slug-only, e.g.
// /title/solo-leveling-arise. Old forms 301 here so shared/bookmarked
// links keep working instead of 404ing:
//   /title/y900062-solo-leveling-arise            -> /title/solo-leveling-arise
//   /title/y900062-solo-leveling-arise/9000621-chapter-1/1
//                                                 -> /title/solo-leveling-arise/chapter-1/1
//   /title/<slug>/9000621-chapter-1/1             -> /title/<slug>/chapter-1/1
// Clean forms (slug, slug/chapter-N[/page], random) serve the SPA shell;
// the SPA entry reroute then renders the title or reader in place, so the
// address bar keeps the clean URL.
const PREFIXED = /^(?:y\d{5,}|ye\d+)-(.+)$/;
const OLD_CHAPTER = /^(\d+)-chapter-(\d+)$/;
const CLEAN_CHAPTER = /^chapter-(\d+)$/;

function redirect(url, path) {
  return new Response(null, {
    status: 301,
    headers: { location: path + url.search, "cache-control": "no-store" },
  });
}

async function serveShell(context) {
  const shell = await context.env.ASSETS.fetch(new Request(new URL("/", context.request.url), context.request));
  return new Response(shell.body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const parts = context.params.path || [];
  const seg1 = parts[0] || "";
  if (seg1 === "random") return serveShell(context);

  const page = (i) => (/^\d+$/.test(parts[i] || "") ? `/${parts[i]}` : "");

  const prefixed = PREFIXED.exec(seg1);
  if (prefixed) {
    const clean = prefixed[1];
    if (parts.length === 1) return redirect(url, `/title/${clean}`);
    const oldCh = OLD_CHAPTER.exec(parts[1] || "");
    if (oldCh) return redirect(url, `/title/${clean}/chapter-${oldCh[2]}${page(2)}`);
    const cleanCh = CLEAN_CHAPTER.exec(parts[1] || "");
    if (cleanCh) return redirect(url, `/title/${clean}/chapter-${cleanCh[1]}${page(2)}`);
    return serveShell(context);
  }

  if (parts.length >= 2) {
    const oldCh = OLD_CHAPTER.exec(parts[1]);
    if (oldCh) return redirect(url, `/title/${seg1}/chapter-${oldCh[2]}${page(2)}`);
  }
  return serveShell(context);
}
