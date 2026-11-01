import { json, getSessionUser, sessionCookies, getSettings, uploadAvatarDataUrl, SESSION_MAX_AGE_SEC, persistRefreshedSession } from "../_lib/db.js";
import { sbSelect, sbInsert, sbAuthTokenSignIn, sbAuthAdminCreateUser, resolveEmail } from "../_lib/supabase.js";

// SPA auth protocol (the original app's own routes, old design):
//   GET  /auth/providers  -> { signup: true }
//   POST /auth/login      { identifier, password } -> session cookie
//   POST /auth/register   { username, password, token } -> creates account
//   GET  /auth/me         -> { user: {...} | null }
//   POST /auth/logout     -> clears session
// GET on /auth/login and /auth/register serves the SPA shell so the FIRST
// load already renders the original (old) SPA auth design — no static
// auth-page copy exists anymore, so first load and refresh are identical.

function hasDb(env) { return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY); }

export async function onRequest(context) {
  return persistRefreshedSession(context.request, await handleRequest(context));
}

async function handleRequest(context) {
  const { env, request } = context;
  const parts = context.params.path || [];
  const method = request.method;

  if (method === "GET" && (parts[0] === "login" || parts[0] === "register") && !parts[1]) {
    // Fetch "/" (not "/index.html": Pages answers /index.html with a 308
    // redirect to /, whose body is empty — that was serving blank pages).
    const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    let html = await shell.text();
    // Inject the LIVE Settings name/logo into the shell before serving it.
    // The SPA reads the site name from meta[name="application-name"] at chunk
    // load (falling back to the baked "BongManga"), which is why auth pages
    // kept the old name after a Settings change while the shell script only
    // rewrote header text and titles starting with "BongManga".
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

  if (parts[0] === "login" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const ident = String(body.identifier || body.email || body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!ident || !password) return json({ error: "Email and password are required." }, 400);
    const email = await resolveEmail(env, ident);
    let tokens;
    try {
      tokens = await sbAuthTokenSignIn(env, email, password);
    } catch {
      return json({ error: "Wrong username or password." }, 401);
    }
    const profile = await sbSelect(env, "profiles", { columns: "*", eq: { id: tokens.user.id }, single: true }).catch(() => null);
    if (!profile) return json({ error: "Wrong username or password." }, 401);
    if (profile.banned) return json({ error: "This account is banned." }, 403);
    const uname = profile.name || (profile.email ? profile.email.split("@")[0] : null);
    return json({ user: { id: profile.id, email: profile.email, name: uname, username: uname, displayName: uname, role: profile.role } }, 200, {
      setCookies: sessionCookies(tokens.access_token, tokens.refresh_token, SESSION_MAX_AGE_SEC),
    });
  }

  if (parts[0] === "register" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const username = String(body.username || body.email || "").trim();
    const password = String(body.password || "");
    if (!username || password.length < 6) return json({ error: "A username and a password of at least 6 characters are required." }, 400);
    const email = username.includes("@") ? username.toLowerCase() : username.toLowerCase() + "@users.aonetsuki.local";
    // Display name: the real name shown after login (header/profile).
    // Empty -> fall back to the username, exactly like before.
    const displayName = String(body.display_name || body.displayName || "").trim().slice(0, 100) || (username.includes("@") ? null : username);
    const name = displayName;
    // Profile picture (file upload only, never URL paste): upload to ImgBB
    // BEFORE creating the account, so a failed upload never leaves a
    // half-complete account without its picture.
    let avatarUrl = null;
    if (body.avatar_data) {
      const up = await uploadAvatarDataUrl(env, body.avatar_data);
      if (up.error) return json({ error: up.error }, 400);
      avatarUrl = up.url;
    }
    const dup = await sbSelect(env, "profiles", { columns: "id", eq: { email }, single: true }).catch(() => null);
    if (dup) return json({ error: "An account with this name already exists. Please log in instead." }, 409);
    let created;
    try {
      const meta = {};
      if (name) meta.display_name = name;
      if (avatarUrl) meta.avatar_url = avatarUrl;
      created = await sbAuthAdminCreateUser(env, email, password, meta);
    } catch {
      return json({ error: "Registration failed. Please try again." }, 500);
    }
    await sbInsert(env, "profiles", [{ id: created.id, email, name, role: "user", created_at: Date.now() }]).catch(() => {});
    return json({ ok: true, user: { id: created.id, email, name, username: name, displayName: name, avatar: avatarUrl, role: "user" } });
  }

  if (parts[0] === "logout" && method === "POST") {
    return json({ ok: true }, 200, { setCookies: sessionCookies(null, null, 0) });
  }

  return json({ error: "Not found." }, 404);
}
