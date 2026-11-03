// Supabase backend for Cloudflare Pages Functions.
// ALL data + auth goes through Supabase. The service_role key lives ONLY in
// Pages secrets (env.SUPABASE_SERVICE_KEY) and is NEVER sent to browsers.
// The anon key is used only server-side for Auth user verification.

export function sbBase(env) {
  return String(env.SUPABASE_URL || "").replace(/\/$/, "");
}

function sbHeaders(env, bearer) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + (bearer || env.SUPABASE_SERVICE_KEY),
    "Content-Type": "application/json",
  };
}

// All Supabase calls go through this wrapper so an upstream stall can never
// hang a request forever: it aborts at 30s and the caller surfaces JSON 500.
async function sbFetch(input, init) {
  return fetch(input, { signal: AbortSignal.timeout(30000), ...(init || {}) });
}

function enc(v) {
  return encodeURIComponent(String(v));
}

// PostgREST select. opts: { columns, eq, neq, ilike, order: [[col, asc]], limit, single }
export async function sbSelect(env, table, opts = {}) {
  const params = new URLSearchParams();
  params.set("select", opts.columns || "*");
  for (const [k, v] of Object.entries(opts.eq || {})) {
    if (v === null || v === undefined) params.append(k, "is.null");
    else params.append(k, "eq." + enc(v));
  }
  for (const [k, v] of Object.entries(opts.neq || {})) params.append(k, "neq." + enc(v));
  for (const [k, v] of Object.entries(opts.ilike || {})) params.append(k, "ilike.*" + enc(v) + "*");
  if (opts.in) for (const [k, vals] of Object.entries(opts.in)) params.append(k, "in.(" + vals.map(enc).join(",") + ")");
  if (opts.order) params.set("order", opts.order.map(([c, asc]) => c + "." + (asc === false ? "desc" : "asc")).join(","));
  if (opts.limit) params.set("limit", String(opts.limit));
  const res = await sbFetch(sbBase(env) + "/rest/v1/" + table + "?" + params.toString(), {
    headers: sbHeaders(env),
  });
  if (!res.ok) throw new Error("supabase select " + table + " failed: " + res.status);
  const data = await res.json();
  if (opts.single) return Array.isArray(data) ? (data[0] || null) : data;
  return Array.isArray(data) ? data : [];
}

export async function sbInsert(env, table, rows, returning = true) {
  const res = await sbFetch(sbBase(env) + "/rest/v1/" + table, {
    method: "POST",
    headers: {
      ...sbHeaders(env),
      Prefer: returning ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("supabase insert " + table + " failed: " + res.status + " " + t.slice(0, 300));
  }
  if (!returning) return [];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

export async function sbUpsert(env, table, rows, onConflict) {
  const res = await sbFetch(sbBase(env) + "/rest/v1/" + table + "?on_conflict=" + enc(onConflict), {
    method: "POST",
    headers: { ...sbHeaders(env), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("supabase upsert " + table + " failed: " + res.status);
  return res.json().catch(() => []);
}

export async function sbUpdate(env, table, values, eq) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(eq || {})) params.append(k, "eq." + enc(v));
  const res = await sbFetch(sbBase(env) + "/rest/v1/" + table + "?" + params.toString(), {
    method: "PATCH",
    headers: { ...sbHeaders(env), Prefer: "return=representation" },
    body: JSON.stringify(values),
  });
  if (!res.ok) throw new Error("supabase update " + table + " failed: " + res.status);
  return res.json().catch(() => []);
}

export async function sbDelete(env, table, eq) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(eq || {})) params.append(k, "eq." + enc(v));
  const res = await sbFetch(sbBase(env) + "/rest/v1/" + table + "?" + params.toString(), {
    method: "DELETE",
    headers: sbHeaders(env),
  });
  if (!res.ok) throw new Error("supabase delete " + table + " failed: " + res.status);
  return true;
}

export async function sbCount(env, table, eq = {}) {
  const params = new URLSearchParams();
  params.set("select", "id");
  // NOTE: PostgREST takes the row count ONLY from the `Prefer: count=exact`
  // header. Sending `count=exact` as a query parameter is parsed as a filter
  // on a column named "count" and fails with PGRST100 ("failed to parse filter
  // (exact)"), which made this function return 0 for every table — the reason
  // the admin Dashboard showed 0 manga / 0 chapters / 0 users while list
  // queries (sbSelect) worked fine.
  params.append("limit", "1");
  for (const [k, v] of Object.entries(eq)) params.append(k, "eq." + enc(v));
  const res = await sbFetch(sbBase(env) + "/rest/v1/" + table + "?" + params.toString(), {
    headers: { ...sbHeaders(env), Prefer: "count=exact" },
  });
  if (!res.ok) return 0;
  const range = res.headers.get("content-range") || "";
  const m = range.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// ---- Supabase Auth (server-side bridge) ----
export async function sbAuthTokenSignIn(env, email, password) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.msg || "Invalid email or password.");
    err.status = res.status === 400 ? 401 : res.status;
    err.code = data.error_code || data.code || null;
    err.error_description = data.error_description || null;
    throw err;
  }
  return data; // { access_token, refresh_token, user }
}

// NOTE: Admin API creation does NOT send a confirmation email by itself.
// Callers must follow it with sbAuthResendSignup() (below) so the user
// receives Supabase's FREE confirm-email magic link. email_confirm:false
// leaves the account unconfirmed until the link is clicked.
export async function sbAuthAdminCreateUser(env, email, password, metadata = {}) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/admin/users", {
    method: "POST",
    headers: sbHeaders(env),
    // Email verification (FINAL, 2026-11-03): OTP is OFF. Accounts are
    // NOT auto-confirmed. email_confirm:false leaves the account
    // unconfirmed; the user verifies by clicking Supabase's FREE
    // confirm-email magic link (see sbAuthResendSignup). No session is
    // issued to an unconfirmed account (see getSessionUser gate).
    body: JSON.stringify({ email, password, email_confirm: false, user_metadata: metadata }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.msg || data.message || "Registration failed.");
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function sbAuthAdminUpdateUser(env, userId, attrs) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    method: "PUT",
    headers: sbHeaders(env),
    body: JSON.stringify(attrs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.msg || data.message || "User update failed.");
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function sbAuthGetUser(env, accessToken) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function sbAuthRefresh(env, refreshToken) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export function sessionCookieHeaders(accessToken, refreshToken, maxAgeSec) {
  const base = "Path=/; HttpOnly; SameSite=Lax; Secure";
  if (!accessToken) {
    return {
      "Set-Cookie": [
        "tk_session=; " + base + "; Max-Age=0",
        "tk_refresh=; " + base + "; Max-Age=0",
      ].join(", "),
    };
  }
  // Persistent session (owner order, revised 2026-11-03): the refresh
  // cookie lives as long as the session cookie — no auto-logout. Only
  // an explicit logout (Max-Age=0) or a Supabase-side revocation ends it.
  return {
    "Set-Cookie": [
      "tk_session=" + accessToken + "; " + base + "; Max-Age=" + maxAgeSec,
      "tk_refresh=" + (refreshToken || "") + "; " + base + "; Max-Age=" + maxAgeSec,
    ].join(", "),
  };
}

export function parseCookies(req) {
  const out = {};
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- Email verification by Supabase FREE confirm-email magic link ----
// OTP is OFF (owner order, 2026-11-03). Supabase's free tier sends a
// confirmation email (magic link) — no custom SMTP, no custom domain.
// POST /auth/v1/resend with type "signup" sends (or re-sends) that link
// to an existing unconfirmed user. redirect_to must be allowlisted in
// Supabase Auth -> URL Configuration (Site URL + Redirect URLs); the
// caller passes the site's /verify-email/ page so clicking the link
// brings the user back to the site, where Supabase has already marked
// the email confirmed and the user then logs in with their password.
// Note: Admin-API creation alone sends NO email — this call is what
// actually delivers the link after registration.
export async function sbAuthResendSignup(env, email, redirectTo) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/resend", {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "signup", email, redirect_to: redirectTo || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.msg || "Could not send the verification email.");
    err.status = res.status;
    err.code = data.error_code || data.code || null;
    throw err;
  }
  return data;
}

// Check whether an Auth user (by email) is already confirmed, via the
// Admin API list endpoint. Used by the Verify page's "check" button so
// a user who clicked the link can confirm their status without guessing.
export async function sbAuthUserConfirmed(env, email) {
  const res = await sbFetch(sbBase(env) + "/auth/v1/admin/users?email=" + encodeURIComponent(email), {
    headers: sbHeaders(env),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const users = Array.isArray(data.users) ? data.users : (Array.isArray(data) ? data : []);
  const match = users.find((u) => String(u.email || "").toLowerCase() === String(email).toLowerCase());
  if (!match) return null;
  return Boolean(match.email_confirmed_at);
}

// Resolve a login identifier to an email: email as-is, otherwise a profile name.
// Returns null when a bare identifier matches no profile — the old fallback
// that synthesized "@users.aonetsuki.local" is REMOVED (2026-11-03): those
// addresses can never receive a confirmation email, so they must not be
// silently created or logged in as.
export async function resolveEmail(env, identifier) {
  const ident = String(identifier || "").trim().toLowerCase();
  if (ident.includes("@")) return ident;
  try {
    const rows = await sbSelect(env, "profiles", { columns: "email,name", eq: { name: ident } });
    if (rows.length) return rows[0].email;
  } catch {}
  return null;
}
