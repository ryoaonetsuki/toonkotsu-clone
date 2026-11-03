-- Public reader auth + library + likes (2026-10-31 user-auth pass).
-- Safe to run more than once: ALTER may fail if the column already exists.
ALTER TABLE users ADD COLUMN name TEXT;
CREATE TABLE IF NOT EXISTS user_library (
  user_id INTEGER NOT NULL,
  manga_id INTEGER NOT NULL,
  slug TEXT,
  title TEXT,
  cover TEXT,
  status TEXT,
  added_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (user_id, manga_id)
);
CREATE TABLE IF NOT EXISTS manga_likes (
  user_id INTEGER NOT NULL,
  manga_id INTEGER NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (user_id, manga_id)
);
