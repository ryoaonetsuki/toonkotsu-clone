// Site-name override for the SPA bundle: if the admin set a custom site name
// in Settings, serve the shared chunk with that name instead of the default
// "Aonetsuki". Falls back to the static asset for any error, so the app can
// never break because of this override.
export async function onRequest(context) {
  const fallback = () => context.env.ASSETS.fetch(context.request);
  try {
    if (!context.env.DB) return fallback();
    const row = await context.env.DB.prepare("SELECT value FROM settings WHERE key = 'site_name'").first();
    const name = row && row.value ? String(row.value).trim() : "";
    if (!name || name === "Aonetsuki") return fallback();
    const res = await context.env.ASSETS.fetch(context.request);
    if (!res.ok) return res;
    const text = await res.text();
    const esc = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\u003c").replace(/\n/g, " ");
    const out = text.split('yt="Aonetsuki"').join('yt="' + esc + '"');
    return new Response(out, {
      status: res.status,
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return fallback();
  }
}
