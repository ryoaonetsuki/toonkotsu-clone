# Supabase email template setup — BongManga (FREE, no custom SMTP/domain)

The site's verification email is Supabase's FREE confirm-email magic link.
Supabase's default template looks plain, so this folder holds a premium
BongManga replacement. Nothing here changes code — it is pasted once into
the Supabase dashboard.

## Brand choice

The owner said "Bong Bangla or similar". The template uses **BongManga** —
the site's actual brand (live Settings name, OG banner, footer). Using a
different name in the email would confuse users at the exact moment they
are asked to trust a link. If the owner wants the email rebranded later,
change only the visible "BongManga" text and the banner — never the
template variables.

## Paste steps (old/main project, https://toonkotsu-app.pages.dev)

1. Supabase Dashboard → your project → **Authentication → Sign-in /
   Providers → Email** → turn **"Confirm email" ON**. Without this,
   Supabase will not send confirmation emails and will not reject
   unconfirmed logins at the Auth layer (the site code also gates
   unconfirmed accounts, but the email itself only exists with this ON).
2. **Authentication → URL Configuration**:
   - **Site URL:** `https://toonkotsu-app.pages.dev`
   - **Redirect URLs:** add `https://toonkotsu-app.pages.dev/auth/verify/`
     (and `https://toonkotsu-app.pages.dev/auth/verify/**` if your project
     requires a wildcard). The site code sends `redirect_to` =
     `<site origin>/auth/verify/?email=...`, so this entry must exist or
     Supabase will refuse the redirect.
3. **Authentication → Templates → Confirm signup**:
   - **Subject:** `Verify your BongManga email`
   - **Body:** paste the full contents of `confirm-signup.html`.
   - **Keep these variables EXACTLY as written** — Supabase replaces
     them per email: `{{ .ConfirmationURL }}` (the magic link) and
     `{{ .Email }}` (the recipient). Do not rename, escape, or wrap
     them in extra characters, and do not add any code/OTP field:
     this email carries a LINK, not a code.
4. Save. No custom SMTP and no custom domain are needed — Supabase's
   built-in sender delivers this template on the free tier (it is
   rate-limited, which is fine for a small site; the site also
   rate-limits resends to 3/email/hour).

## How the link returns to the site

Clicking "Verify Your Email" in the email goes to Supabase, which marks
the email confirmed, then redirects to
`https://toonkotsu-app.pages.dev/auth/verify/` (with Supabase's
`token_hash` / `code` / `access_token` parameters). That page detects
the return and shows **"Verified! Now log in"** with a login button —
no code to type. The user then logs in with username/email + password.
The same page has a **Resend verification email** button and an
"I clicked the link — check my status" button (server-checked via
`/api/auth/check-verified`).
