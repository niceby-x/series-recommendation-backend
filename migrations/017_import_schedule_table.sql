-- IMP4-01: adds a singleton import_schedule row so an admin can turn on
-- an unattended daily import instead of only ever triggering one by hand.
--
-- Deliberately a single-row table (id smallint primary key, constrained
-- to 1) rather than a list of schedules -- there is exactly one importer
-- to schedule, and a singleton keeps src/services/importSchedule.ts's
-- read/update logic (and the admin UI's settings form) simple: one row to
-- select, one row to upsert, no "which schedule" disambiguation anywhere.
--
-- keyword and limit_per_type are nullable ON PURPOSE, not defaulted to
-- DEFAULT_KEYWORD/DEFAULT_IMPORT_LIMIT here -- src/services/importRuns.ts's
-- startImportRun() is already the single source of truth for resolving
-- "no keyword/limit given" to its defaults (IMP3-02, IMP1-03), and the
-- scheduler calls that same function. Duplicating the defaults into this
-- table's DDL would just be a second place they could drift out of sync.
--
-- last_triggered_at is what stops the scheduler firing more than once for
-- the same scheduled slot -- see checkAndTriggerScheduledRun in
-- importSchedule.ts, which only triggers when it's null or its calendar
-- date (UTC) is before today's.
--
-- No DB-level "only one running" guard is needed here the way
-- import_runs_one_running_idx (migrations/013) guards import_runs --
-- the scheduler triggers a run by calling startImportRun() directly, the
-- exact same entrypoint POST /admin/import/run uses, so it inherits that
-- guard for free instead of needing one of its own (see IMP4-01's
-- discussion of this in the checklist).
create table if not exists import_schedule (
    id smallint primary key default 1,
    enabled boolean not null default false,
    run_hour_utc smallint not null default 3,
    keyword text,
    limit_per_type integer,
    last_triggered_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint import_schedule_singleton check (id = 1),
    constraint import_schedule_run_hour_range check (run_hour_utc >= 0 and run_hour_utc <= 23)
);

-- Seed the one row it will ever have, disabled by default -- an admin has
-- to opt in from the settings UI, an unattended import never turns itself
-- on just because this migration ran.
insert into import_schedule (id, enabled, run_hour_utc)
values (1, false, 3)
on conflict (id) do nothing;
