-- Run this once in the Supabase SQL editor, then run
-- `npx tsx src/scripts/backfill-release-date.ts` to populate it for
-- existing rows, before deploying the GET /series changes that depend on
-- it (release_date_min/release_date_max filters, sort=newest_release).
--
-- G1-01: New Releases (components/new-releases/NewReleasesAuthed.tsx) used
-- to fake a release date with a deterministic seeded hash of each series'
-- id (lib/newReleasesContent.ts's mockDaysAgoFor), computed client-side
-- over the *entire* unpaginated catalog every page load -- the exact
-- scaling problem this checklist item is about. A real column lets that
-- move to a normal SQL sort/filter (see sort=newest_release and
-- release_date_min/release_date_max on GET /series), same as the existing
-- `year` column already supports for sort=newest.
--
-- Nullable rather than backfilled inline here: the backfill script ports
-- the exact same seeded hash so *existing* rows keep the release date
-- they already appeared to have on New Releases (no visible reshuffling
-- for users), which isn't expressible in plain SQL. New rows going
-- forward should get a real release_date at creation time instead of
-- relying on the backfill script/hash at all.

alter table series add column if not exists release_date date;

create index if not exists series_release_date_idx on series (release_date);
