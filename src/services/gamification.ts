// src/services/gamification.ts
//
// H2-03: Bloom Journey (level/XP) and This Week's Journey (discovery
// streak) were both 100% MOCK_BLOOM_JOURNEY / MOCK_WEEKLY_JOURNEY --
// every signed-in user saw the identical level, XP, and streak. This
// service is the real thing both cards need, backed by the three
// tables in migrations/008_gamification_tables.sql.
//
// Two entry points other routes use:
//   - recordActivity(userId, kind) -- called from POST /ratings and
//     POST /watchlist after a successful write. Fire-and-forget from the
//     caller's side (see those routes): a gamification failure should
//     never fail the rating/watchlist action it's attached to.
//   - getGamificationSummary(userId) -- called from GET
//     /me/gamification. Read-only, safe to call as often as Home loads.
//
// Leveling thresholds, XP amounts, and the week-goal are explicitly
// illustrative/tunable -- see the frontend's own
// "Level thresholds/labels are illustrative" comment on
// MOCK_BLOOM_JOURNEY. Nothing here claims these numbers are the final
// product decision, just that they're real and consistent per user
// rather than fabricated per page load.

import { supabase } from './supabase';

export type ActivityKind = 'rating' | 'watchlist';

// XP paid out for the FIRST qualifying action of each kind on a given
// calendar day (see user_xp_events' unique constraint) -- re-rating the
// same series, or changing a watchlist status again, doesn't pay out a
// second time the same day. A rating is worth more than a watchlist add
// because it takes more from the user (a real 1-10 judgment vs. a single
// click) -- same "effort in, XP out" reasoning a human would apply if
// asked to weight these by hand.
const XP_AMOUNTS: Record<ActivityKind, number> = {
    rating: 20,
    watchlist: 10,
};

// Cumulative XP needed to REACH each level from the previous one (i.e.
// level 2 needs LEVEL_XP_STEP(2) more XP on top of whatever got the user
// to level 1). Grows linearly with level so later levels take
// meaningfully longer without needing a curve-fitting exercise -- easy
// to replace with a different formula later without touching anything
// that calls computeLevelProgress().
function xpStepForLevel(level: number): number {
    return 300 + (level - 1) * 50;
}

const LEVEL_LABELS: { minLevel: number; label: string }[] = [
    { minLevel: 1, label: 'Sprouting Reader' },
    { minLevel: 4, label: 'Curious Bloom' },
    { minLevel: 8, label: 'Devoted Reader' },
    { minLevel: 13, label: 'BL Connoisseur' },
    { minLevel: 20, label: 'Bloom Master' },
];

function labelForLevel(level: number): string {
    let label = LEVEL_LABELS[0].label;
    for (const tier of LEVEL_LABELS) {
        if (level >= tier.minLevel) label = tier.label;
    }
    return label;
}

export interface LevelProgress {
    level: number;
    label: string;
    xp: number;
    xp_to_next: number;
    total_xp: number;
}

// Pure function: total lifetime XP -> level/label/progress-within-level.
// Level is derived here rather than stored, so tuning xpStepForLevel
// later re-levels everyone automatically instead of needing a backfill.
export function computeLevelProgress(totalXp: number): LevelProgress {
    let level = 1;
    let remaining = Math.max(0, totalXp);
    let step = xpStepForLevel(level);

    while (remaining >= step) {
        remaining -= step;
        level += 1;
        step = xpStepForLevel(level);
    }

    return {
        level,
        label: labelForLevel(level),
        xp: remaining,
        xp_to_next: step,
        total_xp: totalXp,
    };
}

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / msPerDay);
}

// Records that `userId` did something worth crediting today, and
// updates their streak. Never throws for "XP already paid out today" --
// that's the expected, common case, not an error. DOES throw for actual
// database failures, so callers can decide whether to log-and-continue
// (see POST /ratings, POST /watchlist -- both treat this as
// non-blocking) or propagate.
export async function recordActivity(userId: number, kind: ActivityKind): Promise<void> {
    const today = todayDateString();

    // 1. This counts as a discovery-activity day regardless of whether
    // XP was already paid out today -- ignoreDuplicates makes this a
    // no-op on the (very common) second call of the day rather than an
    // error.
    const { error: activityDayError } = await supabase
        .from('user_activity_days')
        .upsert([{ user_id: userId, activity_date: today }], {
            onConflict: 'user_id,activity_date',
            ignoreDuplicates: true,
        });
    if (activityDayError) {
        throw new Error('Failed to record activity day: ' + activityDayError.message);
    }

    // 2. Try to claim today's XP for this kind. The unique constraint on
    // (user_id, event_date, kind) is what actually prevents double-
    // paying -- this insert either succeeds (first time today) or fails
    // with 23505 (already claimed today), and only the first case pays
    // out XP below.
    const xpAmount = XP_AMOUNTS[kind];
    const { error: xpEventError } = await supabase
        .from('user_xp_events')
        .insert([{ user_id: userId, event_date: today, kind, xp_amount: xpAmount }]);

    const alreadyClaimedToday = xpEventError?.code === '23505';
    if (xpEventError && !alreadyClaimedToday) {
        throw new Error('Failed to record XP event: ' + xpEventError.message);
    }

    // 3. Update the streak snapshot. Streak only advances on a NEW
    // activity day (last_activity_date !== today going in), same as the
    // "counts once per day" framing above -- five actions in one day is
    // still one day of streak.
    const { data: existing, error: fetchError } = await supabase
        .from('user_stats')
        .select('xp, current_streak_days, longest_streak_days, last_activity_date')
        .eq('user_id', userId)
        .maybeSingle();
    if (fetchError) {
        throw new Error('Failed to read user stats: ' + fetchError.message);
    }

    const previousXp = existing?.xp ?? 0;
    const newXp = previousXp + (alreadyClaimedToday ? 0 : xpAmount);

    let currentStreak = existing?.current_streak_days ?? 0;
    let longestStreak = existing?.longest_streak_days ?? 0;
    const lastActivityDate: string | null = existing?.last_activity_date ?? null;

    if (lastActivityDate !== today) {
        // Consecutive if the last recorded activity day was exactly
        // yesterday; a same-day repeat is filtered out by the check
        // above, so reaching here means either a real gap (reset to 1)
        // or a genuine day-over-day continuation (+1).
        const isConsecutive = lastActivityDate !== null && daysBetween(today, lastActivityDate) === 1;
        currentStreak = isConsecutive ? currentStreak + 1 : 1;
        longestStreak = Math.max(longestStreak, currentStreak);
    }

    const { error: upsertError } = await supabase.from('user_stats').upsert(
        [
            {
                user_id: userId,
                xp: newXp,
                current_streak_days: currentStreak,
                longest_streak_days: longestStreak,
                last_activity_date: today,
                updated_at: new Date().toISOString(),
            },
        ],
        { onConflict: 'user_id' }
    );
    if (upsertError) {
        throw new Error('Failed to update user stats: ' + upsertError.message);
    }
}

export interface WeekDay {
    date: string;
    label: string;
    completed: boolean;
    is_today: boolean;
}

const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// Monday-start week containing `today` -- matches the mock's 'M T W T F
// S S' ordering (WeeklyJourneyCard renders `days` in the order given, no
// reordering of its own).
function currentWeekDates(today: string): string[] {
    const todayDate = new Date(today + 'T00:00:00Z');
    // getUTCDay(): 0=Sunday..6=Saturday. Distance back to this week's
    // Monday, treating Sunday as day 7 so it's the END of the week
    // rather than the start.
    const isoDayOfWeek = todayDate.getUTCDay() === 0 ? 7 : todayDate.getUTCDay();
    const monday = new Date(todayDate);
    monday.setUTCDate(todayDate.getUTCDate() - (isoDayOfWeek - 1));

    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday);
        d.setUTCDate(monday.getUTCDate() + i);
        return d.toISOString().slice(0, 10);
    });
}

export interface GamificationSummary extends LevelProgress {
    current_streak_days: number;
    longest_streak_days: number;
    week: WeekDay[];
    week_completed_count: number;
    week_goal: number;
}

// Discovery-activity goal for the week. Fixed at 7 (one qualifying day
// per day of the week) to match the mock's "Discover 7 new stories this
// week" / goal: 7 -- a product call, not a technical one, so kept as a
// single named constant that's easy to change or make configurable
// later.
const WEEK_GOAL = 7;

export async function getGamificationSummary(userId: number): Promise<GamificationSummary> {
    const today = todayDateString();

    const [statsResult, weekResult] = await Promise.all([
        supabase
            .from('user_stats')
            .select('xp, current_streak_days, longest_streak_days')
            .eq('user_id', userId)
            .maybeSingle(),
        supabase
            .from('user_activity_days')
            .select('activity_date')
            .eq('user_id', userId)
            .in('activity_date', currentWeekDates(today)),
    ]);

    if (statsResult.error) {
        throw new Error('Failed to read user stats: ' + statsResult.error.message);
    }
    if (weekResult.error) {
        throw new Error('Failed to read week activity: ' + weekResult.error.message);
    }

    const totalXp = statsResult.data?.xp ?? 0;
    const activeDates = new Set((weekResult.data || []).map((row: any) => row.activity_date as string));

    const week: WeekDay[] = currentWeekDates(today).map((date, i) => ({
        date,
        label: WEEKDAY_LETTERS[i],
        completed: activeDates.has(date),
        is_today: date === today,
    }));

    return {
        ...computeLevelProgress(totalXp),
        current_streak_days: statsResult.data?.current_streak_days ?? 0,
        longest_streak_days: statsResult.data?.longest_streak_days ?? 0,
        week,
        week_completed_count: week.filter((d) => d.completed).length,
        week_goal: WEEK_GOAL,
    };
}
