# Migrations

This folder is a **manually-run migration log**, not a tracked migration
tool (no `node-pg-migrate`/`knex`/`supabase migration` CLI wired up yet --
the backend talks to Postgres exclusively through the Supabase JS client,
which has no built-in migration runner, so adopting one of those would mean
introducing a direct Postgres connection just for this). Until that's worth
the extra dependency, this README plus one file per change is the
"at minimum a migrations log" bar from P2-09.

## Convention

- One file per change: `NNN_short_description.sql`, numbered in the order
  they need to run (zero-padded, three digits).
- Every file is idempotent (`create table if not exists`, `add column if
  not exists`, etc.) so re-running one that already applied is a no-op
  instead of an error -- there's no tracking table recording what's already
  run, so idempotency is what keeps that safe.
- Each file's header comment says which route(s) depend on it and what
  breaks if it hasn't been run yet.

## How to run one

1. Open the Supabase SQL editor for the target project.
2. Paste the file's contents and run it.
3. Deploy the code that depends on it (each file's header says which
   routes need it).

Run files **in numeric order** if you're setting up a fresh database --
later files sometimes depend on tables/columns earlier ones create (e.g.
`005` assumes `ratings` already exists from before this folder started).

## Log

| # | File | What it does | Depends on / needed by |
|---|------|---------------|--------------------------|
| 001 | `001_user_moderation_columns.sql` | Adds `is_admin`, `is_banned` to `users` | `/admin/users/:id/admin`, `/admin/users/:id/ban` |
| 002 | `002_curator_picks_table.sql` | Creates `curator_picks` | `/curator-picks`, `/admin/curator-picks` |
| 003 | `003_import_runs_table.sql` | Creates `import_runs` | `/admin/import/run`, `/admin/import/status` |
| 004 | `004_collections_tables.sql` | Creates `collections`, `collection_series` | `/collections`, `/admin/collections` |
| 005 | `005_ratings_unique_constraint.sql` | Adds unique `(user_id, series_id)` on `ratings` | `POST /ratings` upsert (P1-05) |
| 006 | `006_admin_actions_table.sql` | Creates `admin_actions` | Audit logging in `/admin/users` (promote/demote, ban/unban, delete) and `/admin/candidates` (approve/reject/restore) (A2-02) |
| 007 | `007_series_rank_snapshots.sql` | Creates `series_rank_snapshots` | `POST /admin/rank-snapshots/run`, `GET /series`'s `rank`/`rank_trend` fields (H2-01) |
| 008 | `008_gamification_tables.sql` | Creates `user_stats`, `user_activity_days`, `user_xp_events` | `POST /ratings`, `POST /watchlist` (fire-and-forget XP/streak recording), `GET /me/gamification` (H2-03) |
| 009 | `009_episode_progress.sql` | Creates `user_episode_progress` | `PUT /watchlist/:seriesId/progress`, `GET /watchlist`'s `progress` field, `GET /me/activity`'s `progress` entries (H2-02) |
| 010 | `010_series_release_date.sql` | Adds `release_date` to `series` | `GET /series`'s `release_date_min`/`release_date_max` filters and `sort=newest_release` |
| 011 | `011_notifications_columns.sql` | Adds `episode_count_updated_at` to `series`, `notifications_seen_at` to `users` | `GET /me/notifications`, `POST /me/notifications/seen`, the `episode_count_updated_at` bump in `PATCH /admin/series/:id` (G3-01) |
| 012 | `012_series_publish_status.sql` | Adds `publish_status` to `series` | `GET/PATCH/POST /admin/series`, public `GET /series` and `GET /series/:id` (excludes draft/archived) (S1-01) |
| 013 | `013_import_runs_running_unique.sql` | Adds a partial unique index on `import_runs(status) WHERE status = 'running'` | `POST /admin/import/run` (IMP1-01) |
| 014 | `014_import_runs_dry_run_column.sql` | Adds `dry_run` to `import_runs` | `POST /admin/import/run`, `GET /admin/import/status` (IMP2-03) |
| 015 | `015_import_runs_summary_column.sql` | Adds `summary` (jsonb) to `import_runs` | `GET /admin/import/status`, `GET /admin/import/history` (IMP3-01, IMP3-03) |
| 016 | `016_import_runs_keyword_column.sql` | Adds `keyword` to `import_runs` | `POST /admin/import/run`, `GET /admin/import/status`, `GET /admin/import/history` (IMP3-02, IMP3-03) |

All sixteen are assumed already applied to production as of this README's
last update -- 015 and 016 were backfilled into this log after the fact
(the columns were already live; only the migration files themselves were
missing), so there's nothing new to run for those two beyond what's
already in Supabase. Run them anyway if you're setting up a fresh
database from scratch.
