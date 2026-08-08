-- Run this once in the Supabase SQL editor before deploying the upserting
-- POST /ratings route (P1-05) -- Postgres' ON CONFLICT needs a matching
-- unique constraint to target, or the upsert throws "no unique or
-- exclusion constraint matching the ON CONFLICT specification" on every
-- call. The ratings table predates this checklist's migrations/ folder
-- (see P2-09) and was never given one, since the original POST /ratings
-- was a plain insert -- one user could already have multiple rows for the
-- same series before this.
--
-- If duplicate (user_id, series_id) rows already exist in production,
-- de-dupe them first (e.g. keep the most recent by id) or this constraint
-- will fail to create.
alter table ratings
    add constraint ratings_user_id_series_id_key unique (user_id, series_id);
