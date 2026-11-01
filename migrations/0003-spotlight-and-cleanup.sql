-- Final polished version: the five banner titles are the homepage hero (Spotlight).
UPDATE manga SET spotlight = 1 WHERE id IN (900001, 900009, 900011, 900031, 900071);
-- Remove junk settings keys left by earlier testing.
DELETE FROM settings WHERE key IN ('a', 'b');
