// Shared auth flow — FINAL owner design (2026-11-03, OTP OFF).
// Supersedes every OTP plan (passwordless OTP, and password+OTP hybrid).
//
//   REGISTRATION (password-based, verify by magic LINK once):
//     email + username + password -> Admin create (email_confirm:false,
//     pending) -> Supabase FREE confirm-email magic link sent to the
//     inbox (POST /auth/v1/resend, type "signup") -> user clicks the
//     link -> Supabase marks the email confirmed and brings the user
//     back to /verify-email/ -> user logs in with username/email +
//     password. No code is ever sent or entered.
//   LOGIN (password-based, identical for users and admins):
//     username/email + password -> password is CHECKED via Supabase
//     token sign-in -> if the account is unconfirmed, login is
//     REJECTED with a distinct email_not_confirmed error pointing to
//     /verify-email/ (plus a resend-confirmation endpoint); if verified
//     and not banned, session cookies are issued immediately
//     (365-day, persistent until manual logout). Admin login is the
//     same password login — no OTP on first login, no OTP after logout.
//     Panel access is gated separately by role (see adminHandler).
//   The password is NEVER ignored. No OTP endpoint in this file sends
//   anything; the old OTP routes in the handlers return a clear
//   "OTP is disabled" error instead.
import { sbSelect, sbInsert, sbAuthAdminCreateUser, sbAuthTokenSignIn, sbAuthResendSignup, sbAuthUserConfirmed, resolveEmail } from "./supabase.js";
import { allowedEmailError, checkResendRateLimit, isEmailNotConfirmedError } from "./email-policy.js";

export function codeError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function checkEmail(email) {
  const clean = cleanEmail(email);
  if (!clean || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw codeError(400, "A valid email address is required.");
  const domainErr = allowedEmailError(clean);
  if (domainErr) throw codeError(403, domainErr);
  return clean;
}

function verifyPageUrl(req, email) {
  let origin = "";
  try { origin = new URL(req.url).origin; } catch {}
  if (!origin || origin === "null") origin = "https://toonkotsu-app.pages.dev";
  return origin + "/verify-email/?email=" + encodeURIComponent(email);
}

async function sendConfirmationEmail(env, req, email) {
  if (checkResendRateLimit(req, email)) throw codeError(429, "Too many verification emails requested. Please wait a while and try again.");
  const redirectTo = verifyPageUrl(req, email);
  try {
    await sbAuthResendSignup(env, email, redirectTo);
  } catch (e) {
    // Supabase rejects a resend for an already-confirmed address; that
    // is not a failure for the user — they can simply log in.
    const confirmed = await sbAuthUserConfirmed(env, email).catch(() => null);
    if (confirmed) return { already_verified: true };
    throw codeError(500, "Could not send the verification email. Please try again later.");
  }
  return { already_verified: false };
}

async function loadProfile(env, authUserId, email, username) {
  let profile = await sbSelect(env, "profiles", { columns: "*", eq: { id: authUserId }, single: true }).catch(() => null);
  if (!profile) {
    await sbInsert(env, "profiles", [{ id: authUserId, email, name: username || null, role: "user", created_at: Date.now() }]).catch(() => {});
    profile = await sbSelect(env, "profiles", { columns: "*", eq: { id: authUserId }, single: true }).catch(() => null);
    if (!profile) profile = { id: authUserId, email, name: username || null, role: "user", banned: false };
  }
  return profile;
}

// ---- Registration: email + username + password, verify by LINK ----
// Returns { email, requires_verification: true, email_sent: boolean }.
// No session is issued here — the user must click the link first.
export async function registerUser(env, req, { email, username, password, avatarUrl }) {
  const clean = checkEmail(email);
  const name = String(username || "").trim();
  if (!name) throw codeError(400, "A username is required.");
  if (!password || String(password).length < 6) throw codeError(400, "Password must be at least 6 characters.");
  let created;
  try {
    created = await sbAuthAdminCreateUser(env, clean, String(password), { name, avatar_url: avatarUrl || undefined });
  } catch (e) {
    throw codeError(e.status === 422 || e.status === 409 ? 409 : 400, "An account with this email already exists, or registration failed.");
  }
  if (!created || !created.id) throw codeError(500, "Registration failed. Please try again.");
  await sbInsert(env, "profiles", [{ id: created.id, email: clean, name, role: "user", created_at: Date.now() }]).catch(() => {});
  // Admin-API creation sends NO email on its own — this is the call
  // that actually delivers Supabase's free confirmation link.
  let email_sent = true;
  try {
    await sendConfirmationEmail(env, req, clean);
  } catch (e) {
    // Account + profile already exist; the user can resend the link
    // from the Verify Your Email page instead of re-registering.
    email_sent = false;
  }
  return { email: clean, requires_verification: true, email_sent };
}

// ---- Password login (shared by normal + admin login, identical) ----
// Returns one of:
//   { tokens, profile }            -> caller issues session cookies now
//   { requires_verification, email, next } -> unconfirmed account:
//        login rejected; user must click the confirmation link first
// Throws 400/401/403 on bad input, wrong password, or banned account.
// There is deliberately NO OTP step here, for any role.
export async function passwordLogin(env, req, { identifier, password }) {
  const raw = String(identifier || "").trim();
  if (!raw) throw codeError(400, "Username or email is required.");
  if (!password) throw codeError(400, "Password is required.");
  // Resolve a bare username to its profile email; an email is used as-is.
  // (No @users.aonetsuki.local synthesis anywhere — resolveEmail returns
  // null for an unknown bare identifier.)
  const email = raw.includes("@") ? cleanEmail(raw) : await resolveEmail(env, raw);
  if (!email) throw codeError(401, "Invalid username/email or password.");
  checkEmail(email);
  let tokens;
  try {
    // PASSWORD IS CHECKED HERE — never ignored.
    tokens = await sbAuthTokenSignIn(env, email, String(password));
  } catch (e) {
    if (isEmailNotConfirmedError(e)) {
      // Unconfirmed account with a correct password: reject login and
      // point at the Verify Your Email page. Do not issue a session.
      return { requires_verification: true, email, next: "/verify-email/?email=" + encodeURIComponent(email) };
    }
    throw codeError(401, "Invalid username/email or password.");
  }
  if (!tokens.user) throw codeError(401, "Invalid username/email or password.");
  // Defence in depth: if Supabase issued tokens for an unconfirmed
  // account (Confirm-email toggle OFF), still do not log it in.
  if (!tokens.user.email_confirmed_at) {
    return { requires_verification: true, email, next: "/verify-email/?email=" + encodeURIComponent(email) };
  }
  const profile = await loadProfile(env, tokens.user.id, email, null);
  if (profile.banned) throw codeError(403, "This account is banned.");
  return { tokens, profile };
}

// ---- Resend the confirmation LINK (not a code) ----
export async function resendConfirmation(env, req, email) {
  const clean = checkEmail(email);
  const r = await sendConfirmationEmail(env, req, clean);
  return { email: clean, already_verified: r.already_verified };
}

// ---- Check whether an email is confirmed yet ----
// Used by the Verify Your Email page after the user clicks the link.
export async function checkVerified(env, email) {
  const clean = checkEmail(email);
  const confirmed = await sbAuthUserConfirmed(env, clean);
  if (confirmed === null) throw codeError(404, "No account was found for this email.");
  return { email: clean, verified: confirmed };
}

// ---- OTP is DISABLED ----
// Kept only so any stale caller gets a clear error instead of silently
// sending a code. No function in this file sends an OTP code.
export function otpDisabledError() {
  return codeError(410, "OTP is disabled. Use email verification: click the BongManga verification link sent to your email, or resend it from the Verify Your Email page.");
}
