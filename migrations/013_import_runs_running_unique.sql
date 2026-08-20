-- Run this once in the Supabase SQL editor before deploying the IMP1-01
-- fix -- POST /admin/import/run now relies on this index as the
-- authoritative guard against two import runs starting at once.
--
-- Previously the only protection was the in-memory importRunState.running
-- flag, checked in the route handler right after `await requireAdmin(...)`
-- -- a yield point. That in-memory check is also inherently powerless
-- against anything outside this one process's memory: a second server
-- instance, or a restart that wipes importRunState without clearing
-- whatever row is still sitting in import_runs as 'running'.
--
-- A partial unique index on (status) WHERE status = 'running' means
-- Postgres itself rejects a second insert while one row already has
-- status = 'running' -- regardless of which process or instance sent it.
-- It's partial (not a plain unique constraint on the column) because
-- 'success' / 'error' / 'interrupted' rows are expected to repeat many
-- times over; only concurrent 'running' rows need to be prevented.
--
-- src/services/importRuns.ts (startImportRun) now checks the insert
-- error for Postgres code 23505 (unique_violation) and, on conflict,
-- resets its own in-memory state and returns without spawning a child
-- process, instead of proceeding untracked.
create unique index if not exists import_runs_one_running_idx
    on import_runs (status)
    where status = 'running';
