// src/services/__tests__/importRuns.test.ts
//
// IMP1-01: covers startImportRun's conflict handling -- the synchronous
// in-memory check (same-process double-start), and the DB-level guard
// (import_runs_one_running_idx, migrations/013) surfaced as a 23505
// unique_violation on the insert (a different process/instance, or a
// restart that cleared this process's in-memory state without clearing
// the DB row). Both paths must reset in-memory state and return without
// spawning a child process; only a clean insert should reach spawn().
//
// IMP1-03: also covers the MAX_IMPORT_LIMIT clamp -- the single source
// of truth for every caller lives here, not in the route, so a limit
// above the max (or at/below zero) must come out clamped in the
// returned { limit }, in importRunState.limit, and in what actually gets
// persisted/passed to the spawned script.
//
// IMP1-04: also covers importRunState.persisted -- it must flip to
// false when the initial import_runs insert fails for a reason other
// than the 23505 conflict (which resets state and bails out before
// persisted is ever touched), and reset back to true at the start of
// every run and on a clean insert.
//
// IMP2-01: covers stopImportRun -- a no-op returning { stopped: false }
// when nothing is running, and otherwise sending SIGTERM to the tracked
// child and marking importRunState.cancelled so the close handler that
// fires once the child actually exits records status: 'cancelled'
// (not 'error') in import_runs.

// IMP2-03: covers dryRun -- forwarded to startImportRun's second param,
// appended to the spawned script's argv as --dry-run, persisted on the
// import_runs insert (migrations/014), and echoed back in the return
// value, all only when explicitly requested (defaults to false/omitted
// throughout otherwise).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const fromMock = vi.fn();
vi.mock('../supabase', () => ({ supabase: { from: (...args: any[]) => fromMock(...args) } }));

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: any[]) => spawnMock(...args) }));

// Shared across queueInsertResult's returned `from('import_runs')` stub --
// see the comment there. Defined once, reset in beforeEach.
const updateMock = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
// Same idea, but for .insert() -- lets tests assert on exactly what was
// persisted for the initial row (e.g. IMP2-03's dry_run), not just that
// spawn() eventually got called.
let insertMock: ReturnType<typeof vi.fn>;
// IMP1-05: stubs the self-heal check's read
// (select('id, started_at').eq(...).order(...).limit(...)) -- defaults to
// "no stuck row found" via queueInsertResult below, so every existing
// conflict-handling test is unaffected unless it opts in with
// queueSelectResult.
let selectMock: ReturnType<typeof vi.fn>;

function queueSelectResult(result: { data: any; error?: any }) {
    selectMock = vi.fn(() => ({
        eq: vi.fn(() => ({
            order: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue(result),
            })),
        })),
    }));
}

import { importRunState, startImportRun, stopImportRun, MAX_IMPORT_LIMIT, DEFAULT_KEYWORD } from '../importRuns';

// A minimal stand-in for the ChildProcess spawn() returns -- just enough
// (stdout/stderr as EventEmitters, plus the process's own 'close'/'error'
// events) for startImportRun's own event wiring to attach without
// throwing.
function makeFakeChild() {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
}

function queueInsertResult(...results: { data: any; error: any }[]) {
    // IMP1-05: the self-heal path can call .insert() a second time in the
    // same startImportRun() call (once the stuck row is cleared) -- a
    // queue lets a test hand back a different result per call instead of
    // always the same one. Single-result callers (every pre-existing
    // test) are unaffected: the last (only) queued result just keeps
    // being returned once the queue is drained.
    const queue = [...results];
    insertMock = vi.fn(() => ({
        select: vi.fn(() => ({
            single: vi.fn().mockImplementation(() =>
                Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0])
            ),
        })),
    }));
    // IMP1-05: default -- no stuck row found -- overridable per-test via
    // queueSelectResult() called after this.
    queueSelectResult({ data: [], error: null });
    fromMock.mockImplementation((table: string) => {
        if (table === 'import_runs') {
            return {
                insert: insertMock,
                // IMP1-05: the self-heal check inside the 23505 branch
                // reads through here. Wrapped in a closure (not a direct
                // reference) so a later queueSelectResult() call in the
                // same test still takes effect -- fromMock itself isn't
                // re-created when only selectMock is reassigned.
                select: (...args: any[]) => selectMock(...args),
                // The 'close'/'error' handlers fire an un-awaited .update()
                // once the fake child emits close() -- stub it as a
                // thenable no-op so those fire-and-forget calls don't
                // throw, same as persistImportLog's own .update() would.
                // Shared reference (not a fresh vi.fn() per call) so tests
                // can assert on what a later close-handler update actually
                // sent, same as they already assert on spawnMock's calls.
                update: updateMock,
            };
        }
        throw new Error('unexpected table ' + table);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    importRunState.running = false;
    importRunState.startedAt = null;
    importRunState.finishedAt = null;
    importRunState.exitCode = null;
    importRunState.limit = null;
    importRunState.logTail = [];
    importRunState.error = null;
    importRunState.persisted = true;
    importRunState.cancelled = false;
    importRunState.dryRun = false;
});

describe('startImportRun', () => {
    it('spawns a child process and returns started: true on a clean insert', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(100);

        expect(result).toEqual({ started: true, limit: 100, dryRun: false, keyword: DEFAULT_KEYWORD });
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(importRunState.running).toBe(true);
        expect(importRunState.limit).toBe(100);
        expect(importRunState.persisted).toBe(true);
        expect(importRunState.dryRun).toBe(false);
        // IMP2-03: a normal (non-dry) run's insert should still persist
        // dry_run: false explicitly, not omit the column.
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ dry_run: false }));

        // Let the child "finish" so its close handler clears the log
        // flush interval -- avoids leaking a live timer past this test.
        fakeChild.emit('close', 0);
    });

    it('returns a conflict without spawning when the in-memory state already shows a run in progress', async () => {
        importRunState.running = true;

        const result = await startImportRun(100);

        expect(result).toEqual({ started: false, conflict: true });
        expect(fromMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns a conflict and resets state without spawning when the insert hits the unique_violation', async () => {
        queueInsertResult({
            data: null,
            error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "import_runs_one_running_idx"',
            },
        });

        const result = await startImportRun(100);

        expect(result).toEqual({ started: false, conflict: true });
        expect(spawnMock).not.toHaveBeenCalled();
        expect(importRunState.running).toBe(false);
        expect(importRunState.startedAt).toBeNull();
        expect(importRunState.limit).toBeNull();
    });

    it('still spawns but flips persisted to false on a non-conflict insert error', async () => {
        queueInsertResult({ data: null, error: { code: '23503', message: 'some other db error' } });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(100);

        expect(result).toEqual({ started: true, limit: 100, dryRun: false, keyword: DEFAULT_KEYWORD });
        expect(spawnMock).toHaveBeenCalledTimes(1);
        // IMP1-04: the run still proceeds untracked (unchanged existing
        // behavior), but the DB row it would have needed for
        // reconcileOrphanedImportRun() doesn't exist, so persisted must
        // reflect that instead of silently claiming the run is being
        // recorded.
        expect(importRunState.persisted).toBe(false);

        fakeChild.emit('close', 0);
    });

    // IMP1-03
    it('clamps a limit above MAX_IMPORT_LIMIT down to the max, and persists/spawns with the clamped value', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(MAX_IMPORT_LIMIT * 10);

        expect(result).toEqual({ started: true, limit: MAX_IMPORT_LIMIT, dryRun: false, keyword: DEFAULT_KEYWORD });
        expect(importRunState.limit).toBe(MAX_IMPORT_LIMIT);
        // The clamped value, not the requested one, is what actually
        // gets handed to the spawned script.
        const spawnArgs = spawnMock.mock.calls[0][1] as string[];
        expect(spawnArgs.some((a) => a.includes('--limit=' + MAX_IMPORT_LIMIT))).toBe(true);
        expect(spawnArgs.some((a) => a.includes('--limit=' + MAX_IMPORT_LIMIT * 10))).toBe(false);

        fakeChild.emit('close', 0);
    });

    // IMP1-05
    it('self-heals: clears a stuck running row past the threshold and retries the insert', async () => {
        const conflict = {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "import_runs_one_running_idx"' },
        };
        queueInsertResult(conflict, { data: { id: 99 }, error: null });
        queueSelectResult({
            data: [{ id: 7, started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }], // 3h old
            error: null,
        });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(100);

        // The stuck row (id 7) got marked interrupted before the retried
        // insert, and the run proceeds normally on top of the new row.
        expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted' }));
        expect(insertMock).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ started: true, limit: 100, dryRun: false, keyword: DEFAULT_KEYWORD });
        expect(spawnMock).toHaveBeenCalledTimes(1);

        fakeChild.emit('close', 0);
    });

    // IMP1-05
    it('does not touch a running row that is recent -- still returns conflict, no self-heal', async () => {
        const conflict = {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "import_runs_one_running_idx"' },
        };
        queueInsertResult(conflict);
        queueSelectResult({
            data: [{ id: 7, started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }], // 5m old
            error: null,
        });

        const result = await startImportRun(100);

        expect(result).toEqual({ started: false, conflict: true });
        expect(spawnMock).not.toHaveBeenCalled();
        // A genuinely in-progress run's row must never be touched.
        expect(updateMock).not.toHaveBeenCalled();
        expect(insertMock).toHaveBeenCalledTimes(1);
    });

    // IMP1-03: defensive lower bound -- nothing currently in the route
    // calls startImportRun with a non-positive limit (it defaults to
    // DEFAULT_IMPORT_LIMIT before calling), but this is the single
    // source of truth for every caller, so it shouldn't trust its input
    // blindly either.
    it('clamps a non-positive limit up to 1', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(0);

        expect(result).toEqual({ started: true, limit: 1, dryRun: false, keyword: DEFAULT_KEYWORD });

        fakeChild.emit('close', 0);
    });
});

describe('startImportRun with dryRun', () => {
    it('appends --dry-run to the spawned argv, persists dry_run: true, and echoes dryRun: true back', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(100, true);

        expect(result).toEqual({ started: true, limit: 100, dryRun: true, keyword: DEFAULT_KEYWORD });
        expect(importRunState.dryRun).toBe(true);
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ dry_run: true }));
        const spawnArgs = spawnMock.mock.calls[0][1] as string[];
        expect(spawnArgs).toContain('--dry-run');

        fakeChild.emit('close', 0);
    });

    it('omits --dry-run and resets importRunState.dryRun to false when the flag is left off a later run', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        let fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);
        await startImportRun(100, true);
        fakeChild.emit('close', 0);

        queueInsertResult({ data: { id: 43 }, error: null });
        fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);
        const result = await startImportRun(100);

        expect(result).toEqual({ started: true, limit: 100, dryRun: false, keyword: DEFAULT_KEYWORD });
        expect(importRunState.dryRun).toBe(false);
        // Second call in this test -- index 1, not 0.
        const spawnArgs = spawnMock.mock.calls[1][1] as string[];
        expect(spawnArgs).not.toContain('--dry-run');

        fakeChild.emit('close', 0);
    });
});

describe('close/error handler persistence (IMP1-05)', () => {
    it('retries the completion write on failure and succeeds on a later attempt, instead of silently dropping it', async () => {
        vi.useFakeTimers();
        try {
            queueInsertResult({ data: { id: 42 }, error: null });
            const fakeChild = makeFakeChild();
            spawnMock.mockReturnValue(fakeChild);
            await startImportRun(100);

            // First two attempts fail (simulating the transient Supabase
            // hiccup from the bug report), third succeeds.
            let call = 0;
            updateMock.mockImplementation(() => ({
                eq: vi.fn().mockImplementation(() =>
                    Promise.resolve(++call < 3 ? { error: { message: 'transient network error' } } : { error: null })
                ),
            }));

            fakeChild.emit('close', 0);
            // Let the retry loop's backoff timers run to completion.
            await vi.runAllTimersAsync();

            // Previously this write was fire-and-forget with zero retries
            // -- it would have been called once and, on failure, left the
            // row stuck at 'running' forever. Now it keeps trying until it
            // succeeds (or exhausts UPDATE_RETRY_ATTEMPTS).
            expect(call).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('stopImportRun', () => {
    it('returns stopped: false without touching anything when no run is in progress', () => {
        const result = stopImportRun();

        expect(result).toEqual({ stopped: false, reason: 'not_running' });
        expect(fromMock).not.toHaveBeenCalled();
    });

    it('sends SIGTERM to the tracked child and marks the run cancelled', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);
        await startImportRun(100);

        const result = stopImportRun();

        expect(result).toEqual({ stopped: true });
        expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
        expect(importRunState.cancelled).toBe(true);

        fakeChild.emit('close', null);
    });

    it("records status: 'cancelled' (not 'error') once the killed child's close handler fires", async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);
        await startImportRun(100);

        stopImportRun();
        // A process killed by SIGTERM reports a null exit code, not 0 --
        // this is what would otherwise fall through to 'error' without
        // importRunState.cancelled disambiguating it.
        fakeChild.emit('close', null);

        expect(importRunState.running).toBe(false);
        expect(updateMock).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'cancelled', exit_code: null })
        );
    });

    it('is a no-op if called again after the run already stopped', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);
        await startImportRun(100);
        stopImportRun();
        fakeChild.emit('close', null);

        const second = stopImportRun();

        expect(second).toEqual({ stopped: false, reason: 'not_running' });
        expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    });
});
