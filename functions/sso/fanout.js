// Legacy redirect target: the SPA used to send post-login/post-register
// navigation through /sso/fanout?r=<target>, but no fanout route ever
// existed, so the browser landed on a blank SPA shell that never
// redirected anywhere. This handler 302-redirects to the requested
// target when it is same-origin, and to "/" otherwise. It sets no
// cookies, reads no database, and uses no Cloudflare service.
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const r = url.searchParams.get("r") || "/";
  let target = "/";
  try {
    if (r.startsWith("/") && !r.startsWith("//")) {
      target = r;
    } else {
      const u = new URL(r);
      if (u.origin === url.origin) target = u.pathname + u.search + u.hash;
    }
  } catch {
    target = "/";
  }
  return Response.redirect(new URL(target, url.origin).toString(), 302);
}
