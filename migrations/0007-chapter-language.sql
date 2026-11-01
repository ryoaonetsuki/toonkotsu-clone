-- 0007: chapters.language + chapters.created_at
-- The chapters table was created with only (id, manga_id, n, label, owner_id),
-- so the admin Add-episode language dropdown value was silently dropped by the
-- insert fallback chain and every chapter rendered as English. created_at is
-- likewise required for real "uploaded X ago" labels and panel-upload credit.
-- created_at MUST stay NULL for pre-existing rows: the code treats any finite
-- created_at (including 0) as a real panel-upload timestamp, so a DEFAULT 0
-- would rewrite every seed chapter's date/uploader display. New inserts stamp
-- Date.now() explicitly (epoch ms, matching manga/reviews/comments).
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS language text DEFAULT 'en';
ALTER TABLE public.chapters ADD COLUMN IF NOT EXISTS created_at bigint;
