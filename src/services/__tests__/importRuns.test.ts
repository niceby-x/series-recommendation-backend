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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const fromMock = vi.fn();
vi.mock('../supabase', () => ({ supabase: { from: (...args: any[]) => fromMock(...args) } }));

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: any[]) => spawnMock(...args) }));

import { importRunState, startImportRun, MAX_IMPORT_LIMIT } from '../importRuns';

// A minimal stand-in for the ChildProcess spawn() returns -- just enough
// (stdout/stderr as EventEmitters, plus the process's own 'close'/'error'
// events) for startImportRun's own event wiring to attach without
// throwing.
function makeFakeChild() {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
}

function queueInsertResult(result: { data: any; error: any }) {
    fromMock.mockImplementation((table: string) => {
        if (table === 'import_runs') {
            return {
                insert: vi.fn(() => ({
                    select: vi.fn(() => ({
                        single: vi.fn().mockResolvedValue(result),
                    })),
                })),
                // The 'close'/'error' handlers fire an un-awaited .update()
                // once the fake child emits close() -- stub it as a
                // thenable no-op so those fire-and-forget calls don't
                // throw, same as persistImportLog's own .update() would.
                update: vi.fn(() => ({
                    eq: vi.fn().mockResolvedValue({ error: null }),
                })),
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
});

describe('startImportRun', () => {
    it('spawns a child process and returns started: true on a clean insert', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(100);

        expect(result).toEqual({ started: true, limit: 100 });
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(importRunState.running).toBe(true);
        expect(importRunState.limit).toBe(100);

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

    it('still spawns (existing IMP1-04 behavior, out of scope here) on a non-conflict insert error', async () => {
        queueInsertResult({ data: null, error: { code: '23503', message: 'some other db error' } });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(100);

        expect(result).toEqual({ started: true, limit: 100 });
        expect(spawnMock).toHaveBeenCalledTimes(1);

        fakeChild.emit('close', 0);
    });

    // IMP1-03
    it('clamps a limit above MAX_IMPORT_LIMIT down to the max, and persists/spawns with the clamped value', async () => {
        queueInsertResult({ data: { id: 42 }, error: null });
        const fakeChild = makeFakeChild();
        spawnMock.mockReturnValue(fakeChild);

        const result = await startImportRun(MAX_IMPORT_LIMIT * 10);

        expect(result).toEqual({ started: true, limit: MAX_IMPORT_LIMIT });
        expect(importRunState.limit).toBe(MAX_IMPORT_LIMIT);
        // The clamped value, not the requested one, is what actually
        // gets handed to the spawned script.
        const spawnArgs = spawnMock.mock.calls[0][1] as string[];
        expect(spawnArgs.some((a) => a.includes('--limit=' + MAX_IMPORT_LIMIT))).toBe(true);
        expect(spawnArgs.some((a) => a.includes('--limit=' + MAX_IMPORT_LIMIT * 10))).toBe(false);

        fakeChild.emit('close', 0);
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

        expect(result).toEqual({ started: true, limit: 1 });

        fakeChild.emit('close', 0);
    });
});
