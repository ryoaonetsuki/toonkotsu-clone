import { json, getSessionUser, sessionCookies, getSettings, uploadAvatarDataUrl, SESSION_MAX_AGE_SEC, persistRefreshedSession } from "../_lib/db.js";
import { sbSelect, sbInsert } from "../_lib/supabase.js";
import { allowedEmailError } from "../_lib/email-policy.js";
import { registerUser, passwordLogin, resendConfirmation, checkVerified, otpDisabledError } from "../_lib/code-auth.js";

// Auth protocol — FINAL design (2026-11-03, OTP OFF):
//   GET  /auth/providers  -> { signup: true }
//   POST /auth/register   { email, username, password } -> account
//        created unconfirmed + Supabase FREE confirm-email magic link
//        sent; user clicks the link, returns to /verify-email/, then
//        logs in with username/email + password.
//   POST /auth/login      { identifier/email/username, password } ->
//        password CHECKED; verified user gets a persistent (365-day)
//        session at once; unconfirmed user gets requires_verification
//        pointing to /verify-email/. No OTP, for any role.
//   POST /auth/resend-confirmation { email } -> re-sends the link.
//   POST /auth/check-verified { email } -> { verified: true/false }.
//   POST /auth/send-code, /auth/verify-code, /auth/resend -> 410,
//        OTP is disabled.
//   GET  /auth/me         -> { user: {...} | null }
//   POST /auth/logout     -> clears session
// GET on /auth/login and /auth/register serves the SPA shell; the
// canonical register entry is the standalone page /verify-email/.

function hasDb(env) { return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY); }

export async function onRequest(context) {
  return persistRefreshedSession(context.request, await handleRequest(context));
}

async function handleRequest(context) {
  const { env, request } = context;
  const parts = context.params.path || [];
  const method = request.method;

  if (method === "GET" && parts[0] === "verify") {
    // Legacy path: the static verify page lives at /verify-email/ (a
    // /auth/* static file is shadowed by this function route and served empty).
    return Response.redirect(new URL("/verify-email/" + (new URL(request.url).search || ""), request.url), 302);
  }

  if (method === "GET" && (parts[0] === "login" || parts[0] === "register") && !parts[1]) {
    // Fetch "/" (not "/index.html": Pages answers /index.html with a 308
    // redirect to /, whose body is empty — that was serving blank pages).
    const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    let html = await shell.text();
    // Inject the LIVE Settings name/logo into the shell before serving it.
    // The SPA reads the site name from meta[name="application-name"] at chunk
    // load (falling back to the baked "Aonetsuki"), which is why auth pages
    // kept the old name after a Settings change while the shell script only
    // rewrote header text and titles starting with "Aonetsuki".
    try {
      const st = await getSettings(env);
      const name = (st.site_name || "").trim();
      const logo = (st.logo_url || "").trim();
      const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      if (name) {
        html = html.replace(/<meta name="application-name" content="[^"]*"/, `<meta name="application-name" content="${esc(name)}"`);
        html = html.replace(/<meta property="og:site_name" content="[^"]*"/, `<meta property="og:site_name" content="${esc(name)}"`);
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${parts[0] === "login" ? "Login" : "Register"} - ${esc(name)}</title>`);
      }
      if (logo) {
        html = html.replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${esc(logo)}"`);
      }
    } catch {}
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!hasDb(env)) return json({ error: "Database is not configured." }, 503);

  if (parts[0] === "providers" && method === "GET") {
    return json({ signup: true });
  }

  if (parts[0] === "me" && method === "GET") {
    const u = await getSessionUser(env, request);
    // Same username/displayName fix as the /api bridge: the upstream
    // session store falls back to the literal "Account" without these.
    const uname = u ? (u.name || (u.email ? u.email.split("@")[0] : null)) : null;
    return json({ user: u ? { id: u.id, email: u.email, name: uname, username: uname, displayName: uname, avatar: u.avatar || null, role: u.role } : null });
  }

  // FINAL: password login. The password is CHECKED (never ignored).
  // Verified users (any role) get a persistent session at once, no OTP.
  // Unconfirmed users are rejected with requires_verification pointing
  // to the Verify Your Email page.
  if (parts[0] === "login" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const identifier = String(body.identifier || body.email || body.username || "");
    const password = String(body.password || "");
    try {
      const r = await passwordLogin(env, request, { identifier, password });
      if (r.requires_verification) return json({ ok: true, requires_verification: true, email: r.email, error: "email_not_confirmed", next: r.next });
      const profile = r.profile;
      const uname = profile.name || (profile.email ? profile.email.split("@")[0] : null);
      return json({ user: { id: profile.id, email: profile.email, name: uname, username: uname, displayName: uname, role: profile.role } }, 200, {
        setCookies: sessionCookies(r.tokens.access_token, r.tokens.refresh_token, SESSION_MAX_AGE_SEC),
      });
    } catch (e) {
      return json({ error: e.message || "Invalid username/email or password." }, e.status || 401);
    }
  }

  // FINAL: registration — email + username + password, account created
  // unconfirmed, Supabase FREE confirm-email magic link sent. The user
  // clicks the link, returns to /verify-email/ verified, then logs in
  // with username/email + password. No code is sent or entered.
  if (parts[0] === "register" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const email = String(body.email || (String(body.username || "").includes("@") ? body.username : "") || "").trim().toLowerCase();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    try {
      const r = await registerUser(env, request, { email, username: username.includes("@") ? email.split("@")[0] : username, password, avatarUrl: body.avatar_url || body.avatar || null });
      return json({ ok: true, requires_verification: true, email: r.email, email_sent: r.email_sent, next: "/verify-email/?email=" + encodeURIComponent(r.email) });
    } catch (e) {
      return json({ error: e.message || "Registration failed." }, e.status || 400);
    }
  }

  // OTP is DISABLED (owner order, 2026-11-03): these routes no longer
  // send or check any code. Use resend-confirmation for the magic link.
  if ((parts[0] === "resend" || parts[0] === "send-code" || parts[0] === "verify-code") && method === "POST") {
    const e = otpDisabledError();
    return json({ error: e.message }, e.status);
  }

  if (parts[0] === "resend-confirmation" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const email = String(body.email || "").trim().toLowerCase();
    try {
      const r = await resendConfirmation(env, request, email);
      return json({ ok: true, email: r.email, already_verified: r.already_verified, message: r.already_verified ? "This email is already verified. You can log in." : "A verification email has been sent. Click the link in it." });
    } catch (e) {
      return json({ error: e.message || "Could not send the verification email." }, e.status || 500);
    }
  }

  if (parts[0] === "check-verified" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const email = String(body.email || "").trim().toLowerCase();
    try {
      const r = await checkVerified(env, email);
      return json({ ok: true, email: r.email, verified: r.verified });
    } catch (e) {
      return json({ error: e.message || "Could not check verification status." }, e.status || 404);
    }
  }


  if (parts[0] === "logout" && method === "POST") {
    return json({ ok: true }, 200, { setCookies: sessionCookies(null, null, 0) });
  }

  return json({ error: "Not found." }, 404);
}
