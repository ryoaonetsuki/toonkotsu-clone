// Email-domain policy for registration and login (added 2026-11-03).
// Only real, professional providers may register or log in. Disposable /
// temp-mail domains are explicitly blocked, and the old bare-username
// synthesis (@users.aonetsuki.local) is no longer a valid registration
// path — a real email from an allowed provider is required, because only
// such an address can receive the Supabase confirmation email.

// Owner-chosen allowlist (2026-11-03): Gmail, Outlook, ProtonMail,
// Yahoo and iCloud families only.
export const ALLOWED_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "yahoo.com", "yahoo.co.uk", "yahoo.in",
  "icloud.com", "me.com", "mac.com",
]);

// Known disposable / temp-mail providers. This is a blocklist on top of
// the allowlist above (defence in depth: even if a domain were added to
// the allowlist by mistake, a disposable one is still rejected).
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "mailinator.net", "mailinator.org",
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "temp-mail.org", "tempmail.com", "temp-mail.io", "tempmail.net", "temp-mail.de",
  "10minutemail.com", "10minutemail.net", "10minutemail.org",
  "throwawaymail.com", "trashmail.com", "trashmail.net", "trashmail.org",
  "dispostable.com", "getnada.com", "maildrop.cc", "mailnesia.com",
  "sharklasers.com", "yopmail.com", "yopmail.net", "yopmail.fr",
  "fakeinbox.com", "tempinbox.com", "burnermail.io", "mohmal.com",
  "emailondeck.com", "inboxbear.com", "tmail.com", "mailcatch.com",
  "spamgourmet.com", "mytemp.email", "tmpmail.org", "tempmailo.com",
]);

const DISPOSABLE_PATTERNS = [
  /(^|[^a-z0-9])(temp|tmp|throwaway|disposable|trash|burner|fake|spam|guerrilla|minute|anonym)([^a-z0-9]|$)/,
];

export function emailDomainOf(email) {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(String(email || "").trim().toLowerCase());
  return m ? m[1] : null;
}

// Returns null when the email is allowed, otherwise a human-readable error.
// The same check is used at registration AND login so a temp-mail account
// cannot be used even if it was created before this policy existed.
export function allowedEmailError(email) {
  const domain = emailDomainOf(email);
  if (!domain) return "A valid email address is required.";
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return "Temporary or disposable email addresses are not allowed. Please use a Gmail, Outlook, ProtonMail, Yahoo or iCloud address.";
  }
  if (DISPOSABLE_PATTERNS.some((re) => re.test(domain))) {
    return "Temporary or disposable email addresses are not allowed. Please use a Gmail, Outlook, ProtonMail, Yahoo or iCloud address.";
  }
  if (!ALLOWED_EMAIL_DOMAINS.has(domain)) {
    return "Only Gmail, Outlook, ProtonMail, Yahoo and iCloud email addresses can be used to register or log in.";
  }
  return null;
}

export function isAllowedEmail(email) {
  return allowedEmailError(email) === null;
}

// Best-effort verification-email resend rate limiting for Pages
// Functions. LIMITATION, stated honestly: Pages Functions are stateless
// across isolates/regions, so this in-memory window only limits bursts
// hitting the SAME isolate; it is not a global counter. Supabase's own
// resend throttling is the real backstop.
// Limits: 3 resends per email per hour, 10 per IP per hour.
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const resendHits = new Map(); // key -> [timestamps]
export function checkResendRateLimit(request, email) {
  const now = Date.now();
  const ip = (request && request.headers.get("cf-connecting-ip")) || "unknown";
  const keys = [`email:${String(email).toLowerCase()}`, `ip:${ip}`];
  const limits = [3, 10];
  for (let i = 0; i < keys.length; i++) {
    const hits = (resendHits.get(keys[i]) || []).filter((t) => now - t < RESEND_WINDOW_MS);
    if (hits.length >= limits[i]) return true;
    hits.push(now);
    resendHits.set(keys[i], hits);
  }
  return false;
}

// Supabase reports an unconfirmed login in two ways, depending on the
// dashboard "Confirm email" toggle: either the token endpoint itself
// rejects with "Email not confirmed", or it issues tokens whose user has
// email_confirmed_at === null. Both must map to the resend flow.
export function isEmailNotConfirmedError(err) {
  const msg = String((err && (err.message || err.error_description)) || "").toLowerCase();
  const code = String((err && (err.code || err.error_code)) || "").toLowerCase();
  return msg.includes("email not confirmed") || code === "email_not_confirmed";
}
