// src/services/__tests__/gamification.test.ts
//
// H2-03: covers computeLevelProgress's pure leveling math,
// recordActivity's XP-dedupe + streak logic, and getGamificationSummary's
// week-building/defaults. System time is pinned with vi.setSystemTime so
// "today"/"this week" are deterministic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fromMock = vi.fn();
vi.mock('../supabase', () => ({ supabase: { from: (...args: any[]) => fromMock(...args) } }));

import { computeLevelProgress, recordActivity, getGamificationSummary } from '../gamification';

beforeEach(() => {
    vi.clearAllMocks();
    // Tuesday, 2026-08-11 -- matches this conversation's "today" so the
    // Monday-start week math below is easy to hand-check: week is
    // 2026-08-10 (Mon) through 2026-08-16 (Sun).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('computeLevelProgress', () => {
    it('starts at level 1 with 0 xp needing the level-1 step', () => {
        expect(computeLevelProgress(0)).toEqual({
            level: 1,
            label: 'Sprouting Reader',
            xp: 0,
            xp_to_next: 300,
            total_xp: 0,
        });
    });

    it('rolls over into the next level once the step is met', () => {
        // Level 1 needs 300. Exactly 300 total XP means level 1 is
        // complete and 0 xp is banked toward level 2's 350 step.
        expect(computeLevelProgress(300)).toMatchObject({ level: 2, xp: 0, xp_to_next: 350 });
        // 349 more (649 total) is one short of level 3.
        expect(computeLevelProgress(649)).toMatchObject({ level: 2, xp: 349, xp_to_next: 350 });
    });

    it('picks the highest label tier the level qualifies for', () => {
        expect(computeLevelProgress(0).label).toBe('Sprouting Reader');
        // Level 12 (matching the old mock's level) should land in the
        // 8-12 "Devoted Reader" tier, not roll over into BL Connoisseur
        // (13+) or stay at Curious Bloom (4-7).
        const level12Xp = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].reduce((sum, l) => sum + 300 + (l - 1) * 50, 0);
        expect(computeLevelProgress(level12Xp)).toMatchObject({ level: 12, label: 'Devoted Reader' });
    });

    it('treats negative xp as zero rather than going negative', () => {
        expect(computeLevelProgress(-50)).toMatchObject({ level: 1, xp: 0 });
    });
});

describe('recordActivity', () => {
    function mockChain(overrides: Record<string, any>) {
        fromMock.mockImplementation((table: string) => {
            if (!(table in overrides)) throw new Error('unexpected table ' + table);
            return overrides[table];
        });
    }

    it('awards XP and starts a streak of 1 on a brand-new user\'s first activity', async () => {
        const upsertActivityDay = vi.fn().mockResolvedValue({ error: null });
        const insertXpEvent = vi.fn().mockResolvedValue({ error: null });
        const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        const upsertStats = vi.fn().mockResolvedValue({ error: null });

        mockChain({
            user_activity_days: { upsert: upsertActivityDay },
            user_xp_events: { insert: insertXpEvent },
            user_stats: {
                select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
                upsert: upsertStats,
            },
        });

        await recordActivity(7, 'rating');

        expect(upsertActivityDay).toHaveBeenCalledWith(
            [{ user_id: 7, activity_date: '2026-08-11' }],
            { onConflict: 'user_id,activity_date', ignoreDuplicates: true }
        );
        expect(insertXpEvent).toHaveBeenCalledWith([
            { user_id: 7, event_date: '2026-08-11', kind: 'rating', xp_amount: 20 },
        ]);
        expect(upsertStats).toHaveBeenCalledWith(
            [expect.objectContaining({
                user_id: 7,
                xp: 20,
                current_streak_days: 1,
                longest_streak_days: 1,
                last_activity_date: '2026-08-11',
            })],
            { onConflict: 'user_id' }
        );
    });

    it('does not double-pay XP when the day\'s event already exists (23505), but still records the activity day', async () => {
        const upsertActivityDay = vi.fn().mockResolvedValue({ error: null });
        const insertXpEvent = vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
        const maybeSingle = vi.fn().mockResolvedValue({
            data: { xp: 20, current_streak_days: 1, longest_streak_days: 1, last_activity_date: '2026-08-11' },
            error: null,
        });
        const upsertStats = vi.fn().mockResolvedValue({ error: null });

        mockChain({
            user_activity_days: { upsert: upsertActivityDay },
            user_xp_events: { insert: insertXpEvent },
            user_stats: {
                select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
                upsert: upsertStats,
            },
        });

        await recordActivity(7, 'rating');

        // Same day as last_activity_date -> streak unchanged, xp unchanged.
        expect(upsertStats).toHaveBeenCalledWith(
            [expect.objectContaining({ xp: 20, current_streak_days: 1 })],
            { onConflict: 'user_id' }
        );
    });

    it('increments the streak on a consecutive day and updates the longest streak', async () => {
        const maybeSingle = vi.fn().mockResolvedValue({
            data: { xp: 100, current_streak_days: 3, longest_streak_days: 3, last_activity_date: '2026-08-10' },
            error: null,
        });
        const upsertStats = vi.fn().mockResolvedValue({ error: null });

        mockChain({
            user_activity_days: { upsert: vi.fn().mockResolvedValue({ error: null }) },
            user_xp_events: { insert: vi.fn().mockResolvedValue({ error: null }) },
            user_stats: { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })), upsert: upsertStats },
        });

        await recordActivity(7, 'watchlist');

        expect(upsertStats).toHaveBeenCalledWith(
            [expect.objectContaining({ current_streak_days: 4, longest_streak_days: 4 })],
            { onConflict: 'user_id' }
        );
    });

    it('resets the streak to 1 after a gap day, without lowering the longest streak', async () => {
        const maybeSingle = vi.fn().mockResolvedValue({
            data: { xp: 100, current_streak_days: 5, longest_streak_days: 8, last_activity_date: '2026-08-05' },
            error: null,
        });
        const upsertStats = vi.fn().mockResolvedValue({ error: null });

        mockChain({
            user_activity_days: { upsert: vi.fn().mockResolvedValue({ error: null }) },
            user_xp_events: { insert: vi.fn().mockResolvedValue({ error: null }) },
            user_stats: { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })), upsert: upsertStats },
        });

        await recordActivity(7, 'rating');

        expect(upsertStats).toHaveBeenCalledWith(
            [expect.objectContaining({ current_streak_days: 1, longest_streak_days: 8 })],
            { onConflict: 'user_id' }
        );
    });

    it('throws on a real (non-duplicate) xp event error', async () => {
        mockChain({
            user_activity_days: { upsert: vi.fn().mockResolvedValue({ error: null }) },
            user_xp_events: { insert: vi.fn().mockResolvedValue({ error: { code: '500', message: 'db down' } }) },
        });

        await expect(recordActivity(7, 'rating')).rejects.toThrow(/db down/);
    });

    it('throws if recording the activity day fails', async () => {
        mockChain({
            user_activity_days: { upsert: vi.fn().mockResolvedValue({ error: { message: 'db down' } }) },
        });

        await expect(recordActivity(7, 'rating')).rejects.toThrow(/db down/);
    });
});

describe('getGamificationSummary', () => {
    it('returns zeroed defaults for a user with no user_stats row and no activity yet', async () => {
        fromMock.mockImplementation((table: string) => {
            if (table === 'user_stats') {
                return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })) })) };
            }
            if (table === 'user_activity_days') {
                return { select: vi.fn(() => ({ eq: vi.fn(() => ({ in: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) };
            }
            throw new Error('unexpected table ' + table);
        });

        const summary = await getGamificationSummary(7);

        expect(summary).toMatchObject({
            level: 1,
            xp: 0,
            current_streak_days: 0,
            longest_streak_days: 0,
            week_completed_count: 0,
            week_goal: 7,
        });
        expect(summary.week).toHaveLength(7);
        expect(summary.week.every((d) => !d.completed)).toBe(true);
    });

    it('builds a Monday-start week with completed/is_today flags from real activity days', async () => {
        fromMock.mockImplementation((table: string) => {
            if (table === 'user_stats') {
                return {
                    select: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            maybeSingle: vi.fn().mockResolvedValue({
                                data: { xp: 620, current_streak_days: 5, longest_streak_days: 9 },
                                error: null,
                            }),
                        })),
                    })),
                };
            }
            if (table === 'user_activity_days') {
                return {
                    select: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            in: vi.fn().mockResolvedValue({
                                data: [{ activity_date: '2026-08-10' }, { activity_date: '2026-08-11' }],
                                error: null,
                            }),
                        })),
                    })),
                };
            }
            throw new Error('unexpected table ' + table);
        });

        const summary = await getGamificationSummary(7);

        expect(summary.week.map((d) => d.date)).toEqual([
            '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
            '2026-08-14', '2026-08-15', '2026-08-16',
        ]);
        expect(summary.week.map((d) => d.label)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
        expect(summary.week[0].completed).toBe(true); // Mon 08-10
        expect(summary.week[1].completed).toBe(true); // Tue 08-11 (today)
        expect(summary.week[1].is_today).toBe(true);
        expect(summary.week[2].completed).toBe(false); // Wed 08-12, hasn't happened yet
        expect(summary.week_completed_count).toBe(2);
        expect(summary.current_streak_days).toBe(5);
        expect(summary.longest_streak_days).toBe(9);
    });

    it('propagates a user_stats read error', async () => {
        fromMock.mockImplementation((table: string) => {
            if (table === 'user_stats') {
                return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }) })) })) };
            }
            if (table === 'user_activity_days') {
                return { select: vi.fn(() => ({ eq: vi.fn(() => ({ in: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) };
            }
            throw new Error('unexpected table ' + table);
        });

        await expect(getGamificationSummary(7)).rejects.toThrow(/db down/);
    });
});
