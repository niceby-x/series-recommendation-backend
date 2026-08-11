-- Run this once in the Supabase SQL editor before deploying the episode
-- progress routes (H2-02) -- both PUT /watchlist/:seriesId/progress and
-- the progress embed in GET /watchlist depend on this table existing.
--
-- H2-02: the Continue Watching progress bar on Home was a bare 0-1 bar
-- with no label ("Episode 7 - 18 min left") because there was no
-- per-episode progress data anywhere in the schema -- user_lists tracks a
-- coarse watch *status* (plan_to_watch/watching/completed), not a
-- position within the series. This table is that missing position: one
-- row per (user, series), holding the last episode the user was on and
-- (optionally) how many minutes were left in it when they last updated
-- their progress.
--
-- minutes_remaining is nullable and client-supplied rather than derived
-- from a stored per-episode runtime -- the series table has no
-- per-episode runtime data (only episode_count), and building that out
-- is a bigger, separate data-modeling task than this one. A null here
-- just means the frontend shows "Episode 7" without a time estimate,
-- which is still a real improvement over today's bare, unlabeled bar.
--
-- Deliberately its own table rather than new columns on user_lists: a
-- user can have a watchlist status ('watching') with no progress yet
-- (haven't started episode 1), and progress genuinely belongs to the
-- (user, series) pair the same way a rating does -- keeping it separate
-- means it doesn't need to be touched every time watchlist status alone
-- changes (see watchlist.ts's POST /watchlist upsert, which only ever
-- writes status/updated_at today).

create table if not exists user_episode_progress (
    id bigserial primary key,
    user_id integer not null references users(id) on delete cascade,
    series_id integer not null references series(id) on delete cascade,
    current_episode integer not null,
    minutes_remaining integer,
    updated_at timestamptz not null default now(),
    unique (user_id, series_id)
);

create index if not exists user_episode_progress_user_updated_idx
    on user_episode_progress (user_id, updated_at desc);
