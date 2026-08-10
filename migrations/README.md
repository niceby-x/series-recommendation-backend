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

All six are assumed already applied to production as of this README --
this table exists so the next migration (`007_...`) has a clear number to
follow and a place to log itself, not because any of these are still
pending.
