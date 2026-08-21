// src/services/__tests__/importSchedule.test.ts
//
// IMP4-01: covers getImportSchedule/updateImportSchedule's mapping
// to/from the import_schedule row, and checkAndTriggerScheduledRun's
// gating logic -- disabled, not-yet-due (runHourUtc), already-triggered
// today, a manual run already in progress, and the happy path that
// actually calls startImportRun and stamps lastTriggeredAt. Also covers
// that it deliberately does NOT add its own concurrency guard: it relies
// on startImportRun's existing in-memory + DB-level guards (IMP1-01)
// instead of reimplementing one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
vi.mock('../supabase', () => ({ supabase: { from: (...args: any[]) => fromMock(...args) } }));

const { importRunStateMock, startImportRunMock } = vi.hoisted(() => ({
    importRunStateMock: { running: false } as any,
    startImportRunMock: vi.fn(),
}));
vi.mock('../importRuns', () => ({
    importRunState: importRunStateMock,
    startImportRun: startImportRunMock,
    DEFAULT_IMPORT_LIMIT: 150,
}));

import {
    getImportSchedule,
    updateImportSchedule,
    checkAndTriggerScheduledRun,
} from '../importSchedule';

function queueSelectResult(result: { data: any; error: any }) {
    fromMock.mockImplementation((table: string) => {
        if (table !== 'import_schedule') throw new Error('unexpected table ' + table);
        return {
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    maybeSingle: vi.fn().mockResolvedValue(result),
                })),
            })),
        };
    });
}

function queueUpdateResult(result: { data: any; error: any }) {
    const updateMock = vi.fn(() => ({
        eq: vi.fn(() => ({
            select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue(result),
            })),
        })),
    }));
    fromMock.mockImplementation((table: string) => {
        if (table !== 'import_schedule') throw new Error('unexpected table ' + table);
        return { update: updateMock };
    });
    return updateMock;
}

const ROW = {
    enabled: true,
    run_hour_utc: 3,
    keyword: 'boys\u2019 love',
    limit_per_type: 200,
    last_triggered_at: null,
    updated_at: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    importRunStateMock.running = false;
});

describe('getImportSchedule', () => {
    it('maps the DB row to camelCase config', async () => {
        queueSelectResult({ data: ROW, error: null });

        const config = await getImportSchedule();

        expect(config).toEqual({
            enabled: true,
            runHourUtc: 3,
            keyword: 'boys\u2019 love',
            limitPerType: 200,
            lastTriggeredAt: null,
            updatedAt: '2026-08-01T00:00:00.000Z',
        });
    });

    it('returns null if the row is missing (e.g. migration not yet run)', async () => {
        queueSelectResult({ data: null, error: null });

        const config = await getImportSchedule();

        expect(config).toBeNull();
    });

    it('returns null on a DB error rather than throwing', async () => {
        queueSelectResult({ data: null, error: { message: 'boom' } });

        const config = await getImportSchedule();

        expect(config).toBeNull();
    });
});

describe('updateImportSchedule', () => {
    it('rejects an out-of-range runHourUtc without touching the DB', async () => {
        const result = await updateImportSchedule({ enabled: true, runHourUtc: 24 });

        expect(result).toEqual({ ok: false, error: expect.stringContaining('runHourUtc') });
        expect(fromMock).not.toHaveBeenCalled();
    });

    it('rejects a non-integer runHourUtc', async () => {
        const result = await updateImportSchedule({ enabled: true, runHourUtc: 3.5 });

        expect(result.ok).toBe(false);
        expect(fromMock).not.toHaveBeenCalled();
    });

    it('persists keyword/limitPerType as null when omitted, not undefined', async () => {
        const updateMock = queueUpdateResult({ data: { ...ROW, keyword: null, limit_per_type: null }, error: null });

        const result = await updateImportSchedule({ enabled: false, runHourUtc: 5 });

        expect(result.ok).toBe(true);
        expect(updateMock).toHaveBeenCalledWith(
            expect.objectContaining({ keyword: null, limit_per_type: null, enabled: false, run_hour_utc: 5 })
        );
    });

    it('returns ok: false when the update fails', async () => {
        queueUpdateResult({ data: null, error: { message: 'db down' } });

        const result = await updateImportSchedule({ enabled: true, runHourUtc: 3 });

        expect(result).toEqual({ ok: false, error: expect.any(String) });
    });
});

describe('checkAndTriggerScheduledRun', () => {
    const NOON_UTC = new Date('2026-08-21T12:00:00.000Z');

    it('does nothing when the schedule is disabled', async () => {
        queueSelectResult({ data: { ...ROW, enabled: false }, error: null });

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).not.toHaveBeenCalled();
    });

    it('does nothing when the current UTC hour is before runHourUtc', async () => {
        queueSelectResult({ data: { ...ROW, run_hour_utc: 18 }, error: null });

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).not.toHaveBeenCalled();
    });

    it('does nothing when already triggered earlier today', async () => {
        queueSelectResult({
            data: { ...ROW, last_triggered_at: '2026-08-21T04:00:00.000Z' },
            error: null,
        });

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).not.toHaveBeenCalled();
    });

    it('triggers when due and not yet triggered today, even with a stale prior-day timestamp', async () => {
        queueSelectResult({
            data: { ...ROW, last_triggered_at: '2026-08-20T04:00:00.000Z' },
            error: null,
        });
        startImportRunMock.mockResolvedValue({ started: true, limit: 200 });
        // Second from() call is the last_triggered_at stamp after a
        // successful trigger.
        const updateMock = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
        const originalImpl = fromMock.getMockImplementation()!;
        let callCount = 0;
        fromMock.mockImplementation((table: string) => {
            callCount++;
            if (callCount === 1) return originalImpl(table);
            return { update: updateMock };
        });

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).toHaveBeenCalledWith(200, false, 'boys\u2019 love');
        expect(updateMock).toHaveBeenCalledWith(
            expect.objectContaining({ last_triggered_at: NOON_UTC.toISOString() })
        );
    });

    it('falls back to DEFAULT_IMPORT_LIMIT and no keyword override when both are null', async () => {
        queueSelectResult({ data: { ...ROW, keyword: null, limit_per_type: null }, error: null });
        startImportRunMock.mockResolvedValue({ started: true });
        const originalImpl = fromMock.getMockImplementation()!;
        let callCount = 0;
        fromMock.mockImplementation((table: string) => {
            callCount++;
            if (callCount === 1) return originalImpl(table);
            return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) };
        });

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).toHaveBeenCalledWith(150, false, undefined);
    });

    it('does not call startImportRun when a manual run is already in progress, and does not stamp lastTriggeredAt', async () => {
        queueSelectResult({ data: ROW, error: null });
        importRunStateMock.running = true;

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).not.toHaveBeenCalled();
        // Only the initial select -- no second call to stamp last_triggered_at.
        expect(fromMock).toHaveBeenCalledTimes(1);
    });

    it('leaves lastTriggeredAt untouched when startImportRun reports a conflict (lost the race)', async () => {
        queueSelectResult({ data: ROW, error: null });
        startImportRunMock.mockResolvedValue({ started: false, conflict: true });

        await checkAndTriggerScheduledRun(NOON_UTC);

        expect(startImportRunMock).toHaveBeenCalledTimes(1);
        // Only the initial select -- the conflict path returns before
        // any update() call.
        expect(fromMock).toHaveBeenCalledTimes(1);
    });
});
