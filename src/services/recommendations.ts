// src/services/recommendations.ts
//
// H3-01: "Made For You" doesn't exist anywhere on Home -- this is the
// real matching logic the checklist calls for, not a placeholder. The
// review's suggestion was "cross-reference a user's ratings/watchlist/
// mood picks against series tags" -- "mood picks" turned out not to be
// real per-user data (the Moods page is a stateless filter, nothing
// persists which mood a user clicked -- see H1-01), so the two genuine
// signals this schema has are ratings and watchlist activity. Both feed
// the same content-based approach: build a weighted profile of the
// tags/genres behind series the user already engaged with, then score
// every series they HAVEN'T engaged with by how much it overlaps that
// profile.
//
// Deliberately no fallback to "trending" or "curated" for a user with no
// signal yet -- returning generic popular titles under a "Made For You"
// label would be exactly the kind of fake-personalization this checklist
// keeps calling out elsewhere (mockRatingFor, MOCK_BLOOM_JOURNEY, the old
// hardcoded TRENDS array). An empty list with has_enough_signal: false is
// the honest answer for a brand new user; the frontend can show a
// "rate a few shows to unlock this" prompt instead of a section that
// looks personalized but isn't.

import { supabase } from './supabase';

// content_warning tags are deliberately excluded from the matching
// profile -- they describe what a series contains, not what a user
// enjoys, and weighting toward them would recommend MORE of whatever
// warning is attached to a show someone rated highly, which isn't what
// a rating is expressing.
const PREFERENCE_TAG_DIMENSIONS = new Set(['mood', 'trope', 'relationship_dynamic', 'theme']);

// A completed/watching watchlist add is a real positive signal but a
// weaker one than an explicit 1-10 rating (no strength-of-preference
// info in a watchlist add, so it counts for less than even a middling
// rating). plan_to_watch is excluded entirely -- wanting to watch
// something someday says nothing about taste yet.
const WATCHLIST_SIGNAL_WEIGHT = 5;
const MIN_RATING_TO_COUNT_AS_SIGNAL = 6; // below this, a rating is a "didn't like it", not a taste signal to chase more of
const GENRE_MATCH_WEIGHT = 0.5; // scaled down relative to tag weight -- genre is coarser than a specific mood/trope/theme match
const MIN_SCORE_TO_RECOMMEND = 1; // exclude zero-overlap candidates entirely -- "no shared signal" isn't "made for you"
const MAX_REASON_TAGS = 3;

interface SeriesTagRow {
    id: number;
    dimension: string;
    display_label: string;
}

interface ProfileEntry {
    weight: number;
    display_label: string;
}

export interface Recommendation {
    id: number;
    title: string;
    poster_url: string | null;
    year: number;
    country: string;
    score: number;
    match_reasons: string[];
}

export interface RecommendationsResult {
    has_enough_signal: boolean;
    data: Recommendation[];
}

// Fetches the tags/genres for a set of series ids in one round trip each,
// keyed by series_id -- shared by both the profile-building pass (seen
// series) and the candidate-scoring pass (unseen series).
async function fetchTagsAndGenresBySeries(seriesIds: number[]) {
    if (seriesIds.length === 0) {
        return { tagsBySeriesId: new Map<number, SeriesTagRow[]>(), genresBySeriesId: new Map<number, string[]>() };
    }

    const [tagsResult, genresResult] = await Promise.all([
        supabase
            .from('series_tags')
            .select('series_id, tags (id, dimension, display_label)')
            .in('series_id', seriesIds),
        supabase
            .from('series_genres')
            .select('series_id, genres (name)')
            .in('series_id', seriesIds),
    ]);

    if (tagsResult.error) throw new Error(tagsResult.error.message);
    if (genresResult.error) throw new Error(genresResult.error.message);

    const tagsBySeriesId = new Map<number, SeriesTagRow[]>();
    for (const row of (tagsResult.data || []) as any[]) {
        if (!row.tags) continue;
        const list = tagsBySeriesId.get(row.series_id) || [];
        list.push(row.tags);
        tagsBySeriesId.set(row.series_id, list);
    }

    const genresBySeriesId = new Map<number, string[]>();
    for (const row of (genresResult.data || []) as any[]) {
        if (!row.genres?.name) continue;
        const list = genresBySeriesId.get(row.series_id) || [];
        list.push(row.genres.name);
        genresBySeriesId.set(row.series_id, list);
    }

    return { tagsBySeriesId, genresBySeriesId };
}

export async function getRecommendationsForUser(user_id: number, limit = 10): Promise<RecommendationsResult> {
    const [ratingsResult, watchlistResult] = await Promise.all([
        supabase.from('ratings').select('series_id, score').eq('user_id', user_id),
        supabase.from('user_lists').select('series_id, status').eq('user_id', user_id).in('status', ['watching', 'completed']),
    ]);

    if (ratingsResult.error) throw new Error(ratingsResult.error.message);
    if (watchlistResult.error) throw new Error(watchlistResult.error.message);

    // series_id -> signal weight (how strongly this series should
    // influence the taste profile). A series rated AND watchlisted only
    // contributes its (higher) rating weight, not both added together --
    // it's one taste data point about one series, not two.
    const signalWeightBySeriesId = new Map<number, number>();
    for (const row of ratingsResult.data || []) {
        if (row.score >= MIN_RATING_TO_COUNT_AS_SIGNAL) {
            signalWeightBySeriesId.set(row.series_id, row.score);
        }
    }
    for (const row of watchlistResult.data || []) {
        if (!signalWeightBySeriesId.has(row.series_id)) {
            signalWeightBySeriesId.set(row.series_id, WATCHLIST_SIGNAL_WEIGHT);
        }
    }

    // "Seen" = excluded from recommendations, regardless of whether it
    // counted as a positive signal above -- a low rating still means the
    // user has already watched it, so recommending it back is pointless
    // either way.
    const seenSeriesIds = new Set<number>([
        ...(ratingsResult.data || []).map((r) => r.series_id),
        ...(watchlistResult.data || []).map((r) => r.series_id),
    ]);

    if (signalWeightBySeriesId.size === 0) {
        return { has_enough_signal: false, data: [] };
    }

    const { tagsBySeriesId: seenTagsBySeriesId, genresBySeriesId: seenGenresBySeriesId } =
        await fetchTagsAndGenresBySeries([...signalWeightBySeriesId.keys()]);

    // Build the weighted taste profile: tag_id -> accumulated weight
    // (plus its display_label, for turning matches back into human-
    // readable reasons later), and genre_name -> accumulated weight.
    const tagProfile = new Map<number, ProfileEntry>();
    const genreProfile = new Map<string, number>();

    for (const [seriesId, weight] of signalWeightBySeriesId) {
        for (const tag of seenTagsBySeriesId.get(seriesId) || []) {
            if (!PREFERENCE_TAG_DIMENSIONS.has(tag.dimension)) continue;
            const existing = tagProfile.get(tag.id);
            tagProfile.set(tag.id, {
                weight: (existing?.weight || 0) + weight,
                display_label: tag.display_label,
            });
        }
        for (const genreName of seenGenresBySeriesId.get(seriesId) || []) {
            genreProfile.set(genreName, (genreProfile.get(genreName) || 0) + weight);
        }
    }

    // Candidate pool: every series NOT already seen. Fetched separately
    // from the profile-building pass above (different, non-overlapping
    // set of series_ids) rather than pulling the whole `series` table --
    // this schema is seed-data scale today, but there's no reason to load
    // every column of every series just to get ids.
    const { data: allSeries, error: allSeriesError } = await supabase
        .from('series')
        .select('id, title, poster_url, year, country');

    if (allSeriesError) throw new Error(allSeriesError.message);

    const candidates = (allSeries || []).filter((s) => !seenSeriesIds.has(s.id));

    const { tagsBySeriesId: candidateTagsBySeriesId, genresBySeriesId: candidateGenresBySeriesId } =
        await fetchTagsAndGenresBySeries(candidates.map((c) => c.id));

    const scored: Recommendation[] = candidates.map((series) => {
        let score = 0;
        const matchedTags: { label: string; weight: number }[] = [];

        for (const tag of candidateTagsBySeriesId.get(series.id) || []) {
            const profileEntry = tagProfile.get(tag.id);
            if (profileEntry) {
                score += profileEntry.weight;
                matchedTags.push({ label: profileEntry.display_label, weight: profileEntry.weight });
            }
        }

        for (const genreName of candidateGenresBySeriesId.get(series.id) || []) {
            const genreWeight = genreProfile.get(genreName);
            if (genreWeight) {
                score += genreWeight * GENRE_MATCH_WEIGHT;
            }
        }

        // Strongest-matching tags first, deduped, so a series matched on
        // someone's single strongest taste signal doesn't get buried
        // behind weaker ones in the displayed reason.
        const rankedReasons = [...new Map(matchedTags.map((t) => [t.label, t.weight])).entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([label]) => label);

        return {
            id: series.id,
            title: series.title,
            poster_url: series.poster_url,
            year: series.year,
            country: series.country,
            score: Math.round(score * 100) / 100,
            match_reasons: rankedReasons.slice(0, MAX_REASON_TAGS),
        };
    });

    const data = scored
        .filter((s) => s.score >= MIN_SCORE_TO_RECOMMEND)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return { has_enough_signal: true, data };
}
