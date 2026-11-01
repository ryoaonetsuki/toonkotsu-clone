-- 0005-community: tables for the /api/v1/community service (comments +
-- reviews tabs), the Reads counter, and vote tables.
-- Run ONCE in the Supabase SQL editor. Every statement is IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS, so re-running it is harmless, and the API
-- code already works (with empty lists / 0 counts) before it is run.
-- The API degrades gracefully without these tables; this migration is what
-- makes review posts, comment votes, chapter-scoped comments, and the
-- accumulating Reads counter fully persistent.

-- Reviews (one per user per manga; updated on re-rate).
CREATE TABLE IF NOT EXISTS reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manga_id bigint NOT NULL,
  user_id text NOT NULL,
  user_name text,
  rating numeric NOT NULL,
  text text DEFAULT '',
  spoiler boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'approved',
  created_at bigint NOT NULL DEFAULT 0,
  UNIQUE (user_id, manga_id)
);

-- Extra comment columns for chapter scoping, replies, and spoilers.
-- (The base comments table already exists with id, user_id, user_name,
-- body, status, created_at.)
ALTER TABLE comments ADD COLUMN IF NOT EXISTS chapter_id bigint;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id bigint;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS spoiler boolean NOT NULL DEFAULT false;

-- Reads counter: one row per real chapter open (logged by the API's
-- chapter route). GET /api/manga/views counts rows per manga.
CREATE TABLE IF NOT EXISTS manga_views (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manga_id bigint NOT NULL,
  chapter_id bigint,
  created_at bigint NOT NULL DEFAULT 0
);

-- Vote tables (missing tables only disable votes; comments/reviews still work).
CREATE TABLE IF NOT EXISTS comment_votes (
  user_id text NOT NULL,
  comment_id bigint NOT NULL,
  value integer NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

CREATE TABLE IF NOT EXISTS review_votes (
  user_id text NOT NULL,
  review_id bigint NOT NULL,
  helpful boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, review_id)
);
