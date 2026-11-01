import { getSettings } from "./_lib/db.js";

// Serves the logo configured in Settings when one exists; otherwise falls back
// to the bundled logo file. Any failure falls back to the bundled file.
export async function onRequest(context) {
  try {
    if (context.env.SUPABASE_URL) {
      const s = await getSettings(context.env);
      if (s.logo_url) {
        const res = await fetch(s.logo_url);
        if (res.ok) {
          const ct = res.headers.get("content-type") || "image/png";
          const buf = await res.arrayBuffer();
          return new Response(buf, { headers: { "content-type": ct, "cache-control": "public, max-age=3600" } });
        }
      }
    }
  } catch {}
  return context.env.ASSETS.fetch(context.request);
}
