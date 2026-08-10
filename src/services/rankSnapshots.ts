// src/services/rankSnapshots.ts
//
// H2-01: the Home tab's Trending arrows came from a hardcoded
// ['up','down','up','up','flat'] array applied by card position -- no
// relationship to any real signal. This service gives "trend" something
// real to be computed from:
//
// - computeAndStoreSnapshot() ranks every rated series by a popularity
//   score and writes one row per series into series_rank_snapshots for
//   today's date (see migrations/007_series_rank_snapshots.sql). Called
//   from POST /admin/rank-snapshots/run (admin-triggered -- there's no
//   cron scheduler in this app yet, same "manually/externally triggered
//   job" shape as the TMDB import run).
// - getRankTrends() compares today's snapshot to the most recent prior
//   one and returns a per-series { rank, trend } map. GET /series merges
//   this into rank and rank_trend fields on each series (see
//   src/routes/series.ts) so the frontend can drop the hardcoded array.
//
// Ranking is fetched/computed here rather than via a raw SQL window
// function, matching the rest of this codebase's supabase-js-only
// approach (no direct Postgres connection -- see migrations/README.md).

import { supabase } from './supabase';

export type RankTrend = 'up' | 'down' | 'flat' | 'new';

export interface RankTrendEntry {
    rank: number;
    trend: RankTrend;
}

// Popularity score: average_rating weighted by how many ratings back it
// up, so a single 10/10 rating doesn't outrank a title with dozens of
// consistently-good ratings. log(rating_count + 1) is a standard
// diminishing-returns weighting -- the 10th rating moves the score more
// than the 200th does, without needing a fixed volume cutoff.
function popularityScore(averageRating: number, ratingCount: number): number {
    return averageRating * Math.log(ratingCount + 1);
}

// Computes today's rank for every series with at least one rating, and
// upserts one row per series into series_rank_snapshots for today's
// date. Series with zero ratings are left out -- there's no meaningful
// "trend" for a title nobody has rated yet, same reasoning GET /series
// already uses for returning a null average_rating.
//
// Upserted on (series_id, snapshot_date) so re-running this the same day
// (there's no scheduler enforcing "once a day" yet) updates today's row
// instead of creating a duplicate.
export async function computeAndStoreSnapshot(): Promise<{ snapshotDate: string; count: number }> {
    const { data: ratingsData, error: ratingsError } = await supabase
        .from('ratings')
        .select('series_id, score');

    if (ratingsError) {
        throw new Error('Failed to fetch ratings for rank snapshot: ' + ratingsError.message);
    }

    const bySeriesId = new Map<number, number[]>();
    for (const row of (ratingsData || []) as { series_id: number; score: number }[]) {
        const scores = bySeriesId.get(row.series_id) || [];
        scores.push(row.score);
        bySeriesId.set(row.series_id, scores);
    }

    const ranked = Array.from(bySeriesId.entries())
        .map(([series_id, scores]) => {
            const rating_count = scores.length;
            const average_rating = scores.reduce((a, b) => a + b, 0) / rating_count;
            return { series_id, rating_count, average_rating, score: popularityScore(average_rating, rating_count) };
        })
        // Ties (score is derived, so exact ties do happen, e.g. two
        // freshly-rated series) broken by rating_count then series_id so
        // rank assignment is deterministic run to run.
        .sort((a, b) => b.score - a.score || b.rating_count - a.rating_count || a.series_id - b.series_id);

    const snapshotDate = new Date().toISOString().slice(0, 10);

    const rows = ranked.map((entry, index) => ({
        series_id: entry.series_id,
        snapshot_date: snapshotDate,
        rank: index + 1,
        score: entry.score,
    }));

    if (rows.length > 0) {
        const { error: upsertError } = await supabase
            .from('series_rank_snapshots')
            .upsert(rows, { onConflict: 'series_id,snapshot_date' });

        if (upsertError) {
            throw new Error('Failed to store rank snapshot: ' + upsertError.message);
        }
    }

    return { snapshotDate, count: rows.length };
}

// Compares today's snapshot to the most recent snapshot taken before
// today and returns a per-series rank/trend map. Only two dates are
// ever compared (today vs. the prior run), not a running history --
// "trend" here means "did this series move since the last time the job
// ran," same week-over-week framing H2-01 asked for.
//
// Returns an empty map if the job has never been run (no snapshots
// exist yet) -- GET /series treats a missing entry as "no trend data,"
// not as a fabricated 'flat'.
export async function getRankTrends(): Promise<Map<number, RankTrendEntry>> {
    // series_rank_snapshots is small (at most one row per rated series
    // per day the job has run) -- fetched in full and reduced in JS,
    // same "fine at this app's scale" reasoning the admin routes use
    // before P2-04-style pagination is warranted.
    const { data, error } = await supabase
        .from('series_rank_snapshots')
        .select('series_id, snapshot_date, rank')
        .order('snapshot_date', { ascending: false });

    if (error || !data || data.length === 0) {
        return new Map();
    }

    const rows = data as { series_id: number; snapshot_date: string; rank: number }[];
    const dates = Array.from(new Set(rows.map((r) => r.snapshot_date))).sort().reverse();
    const latestDate = dates[0];
    const previousDate = dates[1];

    const latestRanks = new Map<number, number>();
    const previousRanks = new Map<number, number>();
    for (const row of rows) {
        if (row.snapshot_date === latestDate) latestRanks.set(row.series_id, row.rank);
        else if (row.snapshot_date === previousDate) previousRanks.set(row.series_id, row.rank);
    }

    const trends = new Map<number, RankTrendEntry>();
    for (const [series_id, rank] of latestRanks) {
        const previousRank = previousRanks.get(series_id);
        let trend: RankTrend;
        if (previousRank === undefined) trend = 'new';
        // A lower rank number is a better position (rank 1 is #1), so a
        // decreasing number is an "up" trend.
        else if (rank < previousRank) trend = 'up';
        else if (rank > previousRank) trend = 'down';
        else trend = 'flat';
        trends.set(series_id, { rank, trend });
    }

    return trends;
}
