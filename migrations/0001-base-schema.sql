-- Toonkotsu Clone Template — 0001 base schema (run FIRST, then 0002 → 0007 in order).
-- Idempotent: every statement is safe to re-run on an empty or existing database.
-- This creates EMPTY tables only. No manga, chapters, covers, users, or seed rows
-- are included: the admin creates all content through the admin panel.
-- NOTE: the later migrations add further columns/tables (0002 meta columns + ads,
-- 0004 library/likes, 0005 community, 0006 sweep features, 0007 chapter language).

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY,
  email text,
  name text,
  role text NOT NULL DEFAULT 'user',
  created_at bigint
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text
);

CREATE TABLE IF NOT EXISTS manga (
  id bigint PRIMARY KEY,
  code text,
  slug text UNIQUE,
  title text NOT NULL,
  cover text,
  banner text,
  description text,
  meta_title text,
  meta_description text,
  status text NOT NULL DEFAULT 'Ongoing',
  type text NOT NULL DEFAULT 'Manhwa',
  score numeric NOT NULL DEFAULT 0,
  year integer NOT NULL DEFAULT 2020,
  original_language text NOT NULL DEFAULT 'ko',
  translated_language text,
  translation_language text,
  language text,
  tags text,
  spotlight boolean NOT NULL DEFAULT false,
  owner_id uuid,
  created_at bigint
);

CREATE TABLE IF NOT EXISTS chapters (
  id bigint PRIMARY KEY,
  manga_id bigint NOT NULL,
  n integer NOT NULL,
  label text,
  owner_id uuid,
  language text NOT NULL DEFAULT 'en',
  created_at bigint
);

CREATE TABLE IF NOT EXISTS chapter_pages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chapter_id bigint NOT NULL,
  position integer NOT NULL,
  src text NOT NULL,
  w integer,
  h integer
);

CREATE TABLE IF NOT EXISTS comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manga_id bigint,
  user_id uuid,
  user_name text,
  body text,
  status text NOT NULL DEFAULT 'approved',
  created_at bigint
);

CREATE TABLE IF NOT EXISTS reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text,
  target_id bigint,
  reason text,
  user_id uuid,
  user_name text,
  status text NOT NULL DEFAULT 'open',
  created_at bigint
);

CREATE TABLE IF NOT EXISTS activity_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_email text,
  action text,
  created_at bigint
);

-- RLS is intentionally left OFF for these template tables, matching how the
-- template's Pages Functions access Supabase (service key, server-side only).
-- Do NOT expose your service key in the browser; it lives only in Pages secrets.
