-- 0006-sweep: tables for the full-sweep routes added 2026-11-01
-- (Requests/Lists/Moderation curation, chapter likes, reading statistics,
-- reader profiles, notifications, trackers data, page-failure telemetry).
-- Run ONCE in the Supabase SQL editor. Every statement is IF NOT EXISTS,
-- so re-running is harmless. Until it is run, the new GET routes return
-- valid empty states and the new write actions answer a clean JSON 501
-- (never HTML, never a crash) — nothing is faked.
--
-- NOTE: this does NOT replace migrations/0005-community.sql. Run 0005
-- first (reviews, manga_views, comment/reply votes), then this file.

-- Series requests (Requests page + moderation queue).
CREATE TABLE IF NOT EXISTS requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  user_name text,
  title text NOT NULL,
  notes text NOT NULL DEFAULT '',
  reference_url text NOT NULL DEFAULT '',
  external_ids text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open',
  moderation_status text NOT NULL DEFAULT 'approved',
  message text NOT NULL DEFAULT '',
  resolution_series_id bigint,
  created_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS request_votes (
  user_id text NOT NULL,
  request_id bigint NOT NULL,
  PRIMARY KEY (user_id, request_id)
);

-- Reading lists (Lists pages).
CREATE TABLE IF NOT EXISTS lists (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  user_name text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'public',
  created_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS list_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_id bigint NOT NULL,
  series_id bigint NOT NULL,
  note text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS list_votes (
  user_id text NOT NULL,
  list_id bigint NOT NULL,
  PRIMARY KEY (user_id, list_id)
);

-- Chapter likes (title-page / reader like buttons).
CREATE TABLE IF NOT EXISTS chapter_likes (
  user_id text NOT NULL,
  manga_id bigint NOT NULL,
  chapter_id bigint NOT NULL,
  created_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chapter_id)
);

-- Reading statistics events (settings/statistics page sync).
CREATE TABLE IF NOT EXISTS reading_events (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL,
  series_id bigint NOT NULL,
  chapter_id bigint NOT NULL,
  started_at bigint NOT NULL DEFAULT 0,
  ended_at bigint NOT NULL DEFAULT 0,
  page_index integer NOT NULL DEFAULT 0,
  page_count integer NOT NULL DEFAULT 0
);

-- Reader profiles: follows, activity, published sections, blocks.
CREATE TABLE IF NOT EXISTS profile_follows (
  user_id text NOT NULL,
  target_id text NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS profile_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL,
  series_id bigint,
  chapter_id bigint,
  created_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_sections (
  user_id text PRIMARY KEY,
  sections text NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id text NOT NULL,
  target_id text NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

-- Notification settings + subscriptions (settings/notifications page).
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id text PRIMARY KEY,
  settings text NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL DEFAULT 'library-rss',
  name text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  topic text NOT NULL DEFAULT 'chapter',
  enabled boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL DEFAULT 0
);

-- Page-failure telemetry (reader posts these; moderation queue reads them).
CREATE TABLE IF NOT EXISTS page_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  created_at bigint NOT NULL DEFAULT 0
);
