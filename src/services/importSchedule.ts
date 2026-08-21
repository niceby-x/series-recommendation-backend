// src/services/importSchedule.ts -- IMP4-01: an admin-configurable daily
// schedule for the TMDB discovery import, so the catalog can stay fresh
// without someone remembering to click Start Import.
//
// Deliberately thin: this module owns reading/writing the one
// import_schedule row (migrations/017) and the setInterval tick that
// decides whether "now" is due for a run. It does NOT reimplement any of
// startImportRun's own guards -- see checkAndTriggerScheduledRun below,
// which calls startImportRun() the exact same way POST /admin/import/run
// does, and so inherits both the in-memory same-process check and the
// DB-level import_runs_one_running_idx guard (IMP1-01) for free. Landing
// this after every Phase 1 item (per the checklist) is what makes that
// safe to lean on.

import { supabase } from './supabase';
import { importRunState, startImportRun, DEFAULT_IMPORT_LIMIT } from './importRuns';

export interface ImportScheduleConfig {
    enabled: boolean;
    runHourUtc: number;
    keyword: string | null;
    limitPerType: number | null;
    lastTriggeredAt: string | null;
    updatedAt: string;
}

// How often the tick checks whether a scheduled run is due. A run is
// only ever "due" once per calendar day (see the lastTriggeredAt check
// below), so this just needs to be frequent enough that the actual
// trigger doesn't lag runHourUtc by more than a few minutes -- not tied
// to the schedule's own granularity.
const CHECK_INTERVAL_MS = 60 * 1000;

function toConfig(row: any): ImportScheduleConfig {
    return {
        enabled: row.enabled,
        runHourUtc: row.run_hour_utc,
        keyword: row.keyword,
        limitPerType: row.limit_per_type,
        lastTriggeredAt: row.last_triggered_at,
        updatedAt: row.updated_at,
    };
}

// Reads the single import_schedule row. Returns null (rather than
// throwing) if the row is somehow missing -- e.g. migrations/017 hasn't
// been run yet against this database -- so callers (the route and the
// scheduler tick) can each decide how to degrade instead of this module
// picking for them.
export async function getImportSchedule(): Promise<ImportScheduleConfig | null> {
    const { data, error } = await supabase
        .from('import_schedule')
        .select('*')
        .eq('id', 1)
        .maybeSingle();

    if (error || !data) {
        return null;
    }

    return toConfig(data);
}

export interface UpdateImportScheduleInput {
    enabled: boolean;
    runHourUtc: number;
    keyword?: string | null;
    limitPerType?: number | null;
}

// Validates and persists the admin's schedule settings. Deliberately
// does NOT clamp/trim keyword or limitPerType the way startImportRun
// does for a live run (IMP3-02/IMP1-03) -- those clamps apply at trigger
// time, from the single source of truth in importRuns.ts, so this just
// stores what the admin entered (or null to fall back to the defaults)
// and lets startImportRun re-derive the effective values when the
// schedule actually fires. runHourUtc is the one thing validated here,
// since it's meaningless anywhere else in the codebase.
export async function updateImportSchedule(
    input: UpdateImportScheduleInput
): Promise<{ ok: true; config: ImportScheduleConfig } | { ok: false; error: string }> {
    if (!Number.isInteger(input.runHourUtc) || input.runHourUtc < 0 || input.runHourUtc > 23) {
        return { ok: false, error: 'runHourUtc must be an integer between 0 and 23.' };
    }

    const { data, error } = await supabase
        .from('import_schedule')
        .update({
            enabled: input.enabled,
            run_hour_utc: input.runHourUtc,
            keyword: input.keyword ?? null,
            limit_per_type: input.limitPerType ?? null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', 1)
        .select('*')
        .single();

    if (error || !data) {
        return { ok: false, error: 'Failed to save the import schedule.' };
    }

    return { ok: true, config: toConfig(data) };
}

// True once today (UTC) if lastTriggeredAt's calendar date is today's --
// this, not a fixed time window, is what keeps a run from firing more
// than once per scheduled day even though the tick itself runs every
// minute.
function alreadyTriggeredToday(lastTriggeredAt: string | null, now: Date): boolean {
    if (!lastTriggeredAt) return false;
    return new Date(lastTriggeredAt).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

// The scheduler's own tick. Exported (not just wired into the interval
// below) so tests can call it directly instead of faking timers.
export async function checkAndTriggerScheduledRun(now: Date = new Date()): Promise<void> {
    const config = await getImportSchedule();
    if (!config || !config.enabled) return;
    if (now.getUTCHours() < config.runHourUtc) return;
    if (alreadyTriggeredToday(config.lastTriggeredAt, now)) return;

    // A manual run already in progress isn't this module's problem to
    // solve -- startImportRun's own guards (in-memory + the DB unique
    // index) already refuse to double-start safely. Checking
    // importRunState.running here first is just to skip the noise of
    // calling startImportRun (and logging its conflict) on every single
    // tick while a long manual run is going; leaving lastTriggeredAt
    // untouched either way means the next tick retries once that run
    // finishes, rather than silently skipping today's scheduled run.
    if (importRunState.running) return;

    const result = await startImportRun(
        config.limitPerType ?? DEFAULT_IMPORT_LIMIT,
        false,
        config.keyword ?? undefined
    );

    if (!result.started) {
        // Lost the race to something else that started a run between
        // our check above and startImportRun's own insert -- same
        // reasoning as the importRunState.running check: leave
        // lastTriggeredAt alone so the next tick tries again.
        return;
    }

    await supabase
        .from('import_schedule')
        .update({ last_triggered_at: now.toISOString() })
        .eq('id', 1);
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

// Starts the recurring tick. Called once at boot (src/index.ts, alongside
// reconcileOrphanedImportRun) -- idempotent so an accidental second call
// doesn't stack up duplicate intervals.
export function startImportScheduler(): void {
    if (schedulerTimer) return;

    schedulerTimer = setInterval(() => {
        checkAndTriggerScheduledRun().catch((err) => {
            console.error('Scheduled import check failed:', err);
        });
    }, CHECK_INTERVAL_MS);

    // Doesn't keep the process alive on its own during tests/scripts
    // that otherwise have nothing left to do -- same courtesy Node gives
    // you by default for timers you don't need to block shutdown on.
    schedulerTimer.unref?.();
}

// Test-only escape hatch to stop a running interval -- production code
// never needs this (the process just exits with it live), but leaving a
// live setInterval across test files leaks timers and can make later
// tests hang or double-fire.
export function stopImportScheduler(): void {
    if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
    }
}
