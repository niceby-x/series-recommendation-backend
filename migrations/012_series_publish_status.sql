-- Run this once in the Supabase SQL editor before deploying the
-- Series & Movies admin table redesign (S1-01) -- GET/PATCH/POST
-- /admin/series will error (missing columns) until this runs.
--
-- S1-01: the admin Series & Movies table needs a Draft/Published/Archived
-- publish-workflow status, distinct from the existing `status` column
-- (airing/completed/upcoming -- that describes the show's own broadcast
-- state, not whether it's visible in the catalog). publish_status is a
-- brand new, separate concept: 'draft' and 'archived' titles are excluded
-- from the public GET /series and GET /series/:id routes (see series.ts),
-- 'published' titles behave exactly as every title does today.
--
-- Every row already in the table today is a live, publicly-visible title,
-- so existing rows are backfilled to 'published' -- NOT 'draft'. Backfilling
-- to 'draft' would instantly empty the public catalog the moment this runs.
alter table series add column if not exists publish_status text not null default 'published'
    check (publish_status in ('draft', 'published', 'archived'));

-- updated_at / updated_by: the admin table's "Updated" column ("2 May 2025
-- / by Jamie") had nothing to read before this -- series had no
-- modification-tracking columns at all. Set by application code (PATCH
-- /admin/series/:id and POST /admin/series/bulk) rather than a DB trigger,
-- so it can be stamped together with who made the change in one write.
-- updated_at defaults to now() so every existing row has *a* value rather
-- than null (reads as "never edited since this column existed", not
-- literally true, but a null "Updated" column would be a worse first
-- impression on a screen whose whole job is showing that date).
alter table series add column if not exists updated_at timestamptz not null default now();
alter table series add column if not exists updated_by text;

create index if not exists series_publish_status_idx on series (publish_status);
-- media_type already exists on this table (populated by the TMDB import
-- scripts) but was never indexed or exposed via the API/types.ts -- this
-- migration is what starts relying on it (Series & Movies tabs), so it
-- gets an index alongside publish_status.
create index if not exists series_media_type_idx on series (media_type);
