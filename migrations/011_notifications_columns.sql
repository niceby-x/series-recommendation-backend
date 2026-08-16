-- Run this once in the Supabase SQL editor before deploying the
-- GET /me/notifications / POST /me/notifications/seen routes and the
-- PATCH /admin/series/:id change that populates episode_count_updated_at
-- -- both will error (users/series columns missing) or silently never
-- surface a notification (episode_count_updated_at never set) until this
-- runs.
--
-- G3-01: the notifications bell (components/dashboard/DashboardHeader.tsx)
-- was fully static, always rendering "You're all caught up!" regardless of
-- real activity. This wires it to real data: "did any series on my
-- watchlist have its episode_count go up since I last checked the bell."
--
-- series.episode_count_updated_at: nullable, left NULL for every existing
-- row on purpose -- only PATCH /admin/series/:id sets it going forward,
-- and only when episode_count actually increases (see that route's
-- comment). Backfilling it to "now" for every row here would make every
-- currently-airing show look like it just dropped a new episode the
-- moment this migration runs, which is exactly the false-positive flood
-- this is trying to avoid.
--
-- users.notifications_seen_at: nullable, meaning "never opened the bell
-- yet" -- treated as "everything currently qualifies as unread" by
-- GET /me/notifications, same as a real notification inbox a user hasn't
-- opened yet.

alter table series add column if not exists episode_count_updated_at timestamptz;
alter table users add column if not exists notifications_seen_at timestamptz;

create index if not exists series_episode_count_updated_at_idx on series (episode_count_updated_at);
