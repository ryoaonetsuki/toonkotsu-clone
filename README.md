# Toonkotsu Clone — Manga / Manhwa / Webtoon Platform (Template)

> **License — read this first.** This template is **free to download, use, and
> host**, but it is **NOT open source**. You may **not modify any source
> code — not even one line** — including the theme and layout. You may only
> configure it through the **admin panel** (site name, settings, content).
> The footer credit row at the very top of the footer —
> **"Developed by Salman Biswas"** with the GitHub and Telegram links — must
> stay **intact, visible, and unremovable** on every page. Removing it, or
> changing the code, **terminates the license**. Full terms: [`LICENSE.md`](LICENSE.md).

## What this is

A complete manga / manhwa / webtoon reading platform:

- **Frontend:** a fast mobile-first reader hosted on **Cloudflare Pages**
  (`public/` — the built app; `wrangler.toml` points Pages at it).
- **Backend:** **Cloudflare Pages Functions** (`functions/`) — API routes for
  titles, chapters, reader pages, library, likes, comments, reviews, reads,
  requests, lists, groups, and the admin panel.
- **Database + auth:** **Supabase** (Postgres + Supabase Auth). Login and
  registration use Supabase Auth; all content lives in Supabase tables.
- **Images:** **ImgBB** direct upload from the admin panel (covers, chapter
  pages, avatars). No image-URL pasting: uploads go straight to ImgBB.
- **Admin panel:** `/admin/` → `/admin/login/` → `/admin/panel/` — add manga,
  add chapters (with a language/flag picker), manage users & roles (Admin /
  Moderator / User), settings, and ads. Moderators can only manage their own
  uploads. **Manga deletions happen only through the panel Delete button.**
- **Reader:** clean slug URLs (`/title/<slug>/chapter-<n>/<page>`), chapter
  language flags, reading progress ("Back to it" / Continue), library,
  chapter likes, comments, and reviews.

## What is NOT in this template

This template ships **empty** — by design:

- **No manga, chapters, covers, or seed data.** The demo/seed catalogue,
  seed covers, and seed chapter files from the original site are **not**
  included. The fallback data files in `functions/_data/` are empty stubs.
  You create all content yourself in the admin panel.
- **No user accounts.** No admin account, no test users. You create the
  first admin account yourself (step 5 below).
- **No secrets, keys, or tokens.** There are no `.env` files, no API keys,
  and no deploy script with a baked-in token in this repo. You supply every
  secret yourself (step 4 below).
- **Excluded files (and how you supply them instead):**
  - `deploy_demo.py` — excluded: it contained a deployment credential.
    Deploy with `wrangler pages deploy` and your own Cloudflare login instead.
  - `public/yae/` (seed banners/covers/chapter files) — excluded: seed
    content. Upload your own covers/pages through the panel.
  - `public/og-image.jpg` — excluded: site-specific social image. Replace
    it with your own image of the same name if you want one.
  - The original site's `README.md` (a demo-preview note) — replaced by
    this file.

## Prerequisites (all free tiers are enough)

1. A **Cloudflare** account (for Pages + Functions).
2. A **Supabase** account + a new project (any region; Singapore
   `ap-southeast-1` works well for Asia). You need its **Project URL** and
   keys from Project Settings → API.
3. An **ImgBB** account + API key (free). You add this later **in the admin
   panel's Settings**, not as a Pages secret.
4. **Wrangler** (`npx wrangler`) or the Cloudflare dashboard, for deploying.
5. **Git** (optional, only if you want to keep your deployment in sync).

## Setup — step by step

### 1. Create a Supabase project

Create a new project in the Supabase dashboard. Open its **SQL Editor**.

### 2. Run the migrations, in order

In the SQL Editor, run each file in `migrations/` **in this exact order**
(each is idempotent — safe to re-run):

1. `0001-base-schema.sql` — empty base tables: `profiles`, `settings`,
   `manga`, `chapters`, `chapter_pages`, `comments`, `reports`,
   `activity_log`.
2. `0002-bugfix-metadata-ads.sql` — manga meta columns + `ads` table.
   (Adapted for Postgres in this template: identity primary key, and
   `IF NOT EXISTS` on the added columns.)
3. `0003-spotlight-and-cleanup.sql` — spotlight/cleanup (no-ops on a fresh
   database; harmless to run).
4. `0004-userauth-library-likes.sql` — `user_library`, `manga_likes`.
5. `0005-community.sql` — `reviews`, `manga_views`, `comment_votes`,
   `review_votes`, plus comment reply/spoiler columns.
6. `0006-sweep.sql` — `requests`, `lists`, `chapter_likes`,
   `reading_events`, follows/activity, blocks, notifications, and more.
7. `0007-chapter-language.sql` — `chapters.language` + `chapters.created_at`.

> **Why this order matters:** later migrations assume the earlier tables
> exist. If a step fails, fix that step before continuing — do not skip it.
> Comments, reviews, reads counting, likes, requests, and lists will **not**
> work until their tables exist (they fail cleanly with a JSON error, never
> with a broken page, once the code is deployed).

### 3. Enable Supabase Auth (email)

In Supabase → Authentication → Providers, make sure **Email** is enabled.
Users register with an email (or a username — the app synthesises an
internal email for username-only registration) and a password.

### 4. Set the Pages secrets (names only — never commit values)

In Cloudflare → Pages → your project → Settings → Environment variables
(**Secrets**, not plain variables), set exactly these three:

| Secret name | Value (from Supabase) |
|---|---|
| `SUPABASE_URL` | Project URL, e.g. `https://<your-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | The project's `anon` / `publishable` key |
| `SUPABASE_SERVICE_KEY` | The project's `service_role` / secret key |

**Never** put the service key in frontend code, in the repo, or in a
public variable. It is used server-side only, by Pages Functions.

### 5. Deploy to Cloudflare Pages

Option A — dashboard: create a Pages project, connect this repo (or upload
the `public/` folder), and set the **build output directory** to `public`
(this is already in `wrangler.toml`). Pages Functions in `functions/` are
picked up automatically.

Option B — CLI (from this repo's root, logged in to Cloudflare):

```bash
npx wrangler pages deploy public --project-name <your-project-name>
```

Then set the three secrets from step 4 in the dashboard (the CLI does not
need them).

### 6. Create the first admin account

1. Open your deployed site and go to **Register**. Create your account.
2. In Supabase → Table Editor → `profiles`, find your new row and set its
   `role` to `admin`. (There is no public "make me admin" button, by design.)
3. Log in at `/admin/login/` with that account. You should reach
   `/admin/panel/`.

### 7. Finish configuration in the admin panel

1. **Settings → ImgBB API key:** paste your ImgBB key and save. Until this
   is set, image uploads will refuse with "Image hosting is not configured."
2. **Settings → site name, logo, footer text, social links:** set your own.
   (The one thing you may **not** change or remove is the
   **"Developed by Salman Biswas"** credit row at the top of the footer —
   see the license.)
3. **Add your first manga:** Manga → Add manga (title, cover upload, type,
   status, genres), then Chapters → Add episode (chapter number, pages in
   order, language flag). The chapter opens at
   `/title/<your-slug>/chapter-1/1`.
4. **No code edits needed for your domain:** the sitemap uses your
   deployment's own request domain automatically, and the default site
   name `BongManga` is changed only through admin Settings — never by
   editing code (which the license forbids).

## How content, roles, and rules work

- **Admin:** full control (all manga/chapters/users/settings/ads).
- **Moderator:** can add manga and chapters, but only manage their own
  uploads; Settings, Users & Roles, and Ads are hidden from moderators.
- **User:** read-only plus library, likes, comments, reviews.
- **Guests:** can browse everything; like/comment/review/download actions
  ask them to log in instead of failing silently.
- **Counts are real:** Reads count real chapter opens (from the day the
  `manga_views` table exists); Rating is the real average of real reviews
  (`N/A` until the first review — never a fake number); chapter dates are
  real upload times for new uploads; chapter rows credit the real uploader.
- **Deletions:** only through the admin panel Delete buttons (with the
  in-page confirm modal). Never delete rows directly from the database
  unless you fully understand the foreign-key consequences — the panel
  path is the supported one.

## Project layout

```
public/                 Built frontend (Pages build output — do not hand-edit)
  _app/                 App bundles (footer credit lives in the footer chunk)
  admin/                Admin panel (static shell; logic in the panel page)
  auth/                 Login/register shells
functions/              Pages Functions (API + CDN routes)
  _lib/                 Supabase client, DB mapping, admin handlers
  _data/                EMPTY fallback data stubs (no seed content)
  api/ cdn/ auth/ ...   Route handlers
migrations/             Supabase SQL, in run order (0001 → 0007)
wrangler.toml           Pages project config (rename the project to yours)
LICENSE.md              Toonkotsu Clone Template License (no-modification)
README.md               This file
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Image hosting is not configured" | ImgBB key not set in admin Settings |
| Comments/reviews show an "invalid answer" error | A migration was skipped — re-run the migrations in order |
| Reads stay 0 / Rating stays N/A | No chapter opens / no reviews yet since setup — both are honest zeros, not bugs |
| Save buttons hang | Upstream (Supabase/ImgBB) stall — the panel and server both time out after 30s and show a toast; retry |
| Login fails after deploy | Check the three Pages secrets (names above) and that Supabase Email auth is enabled |
| Footer credit missing | You (or someone) modified the code — that violates the license; restore the template verbatim |

## License reminder

Free to download, use, and host. **No code modification — not even one
line. No theme changes. Admin-panel configuration only. Footer credit
("Developed by Salman Biswas" + GitHub + Telegram links) permanent and
unremovable.** Full terms in [`LICENSE.md`](LICENSE.md). Violations
terminate the license.
