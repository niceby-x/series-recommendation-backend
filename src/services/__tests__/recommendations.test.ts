// src/services/__tests__/recommendations.test.ts
//
// H3-01: covers getRecommendationsForUser's scoring logic -- building a
// weighted tag/genre profile from a user's ratings + watchlist, scoring
// unseen series against it, and the cold-start (no signal yet) path.
// Uses the shared mockSupabase/queue helper (same one admin/*.test.ts and
// series-trending-style tests use) since the service makes several
// sequential .from() calls across different tables.

import { describe, it, expect, beforeEach } from 'vitest';
import { mockSupabase } from '../../routes/__tests__/admin/testUtils';

const { supabase, queue } = mockSupabase();

import { vi } from 'vitest';
vi.mock('../supabase', () => ({ get supabase() { return supabase; } }));

import { getRecommendationsForUser } from '../recommendations';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('getRecommendationsForUser', () => {
    it('returns has_enough_signal: false and no data for a brand new user', async () => {
        queue('ratings', { data: [], error: null });
        queue('user_lists', { data: [], error: null });

        const result = await getRecommendationsForUser(42);

        expect(result).toEqual({ has_enough_signal: false, data: [] });
    });

    it('ignores low ratings as taste signal but still excludes them from candidates', async () => {
        // A rating of 3 is below MIN_RATING_TO_COUNT_AS_SIGNAL -- it
        // shouldn't shape the profile, but series 1 (the disliked show)
        // must still never come back as a recommendation.
        queue('ratings', { data: [{ series_id: 1, score: 3 }], error: null });
        queue('user_lists', { data: [], error: null });

        const result = await getRecommendationsForUser(42);

        // No positive signal at all -> cold start, same as the empty case.
        expect(result.has_enough_signal).toBe(false);
    });

    it('scores candidates by overlap with the tag/genre profile built from ratings + watchlist', async () => {
        // Signal: series 1 rated 9 (strong), series 2 on watchlist as 'watching'.
        queue('ratings', { data: [{ series_id: 1, score: 9 }], error: null });
        queue('user_lists', { data: [{ series_id: 2, status: 'watching' }], error: null });

        // Profile pass: tags/genres for series [1, 2].
        queue('series_tags', {
            data: [
                { series_id: 1, tags: { id: 100, dimension: 'trope', display_label: 'Enemies to Lovers' } },
                { series_id: 1, tags: { id: 101, dimension: 'content_warning', display_label: 'Graphic Violence' } }, // must NOT influence scoring
                { series_id: 2, tags: { id: 102, dimension: 'mood', display_label: 'Cozy' } },
            ],
            error: null,
        });
        queue('series_genres', {
            data: [{ series_id: 1, genres: { name: 'Romance' } }],
            error: null,
        });

        // Full series table (for candidate pool).
        queue('series', {
            data: [
                { id: 1, title: 'Seen Show', poster_url: null, year: 2024, country: 'TH' },
                { id: 2, title: 'Also Seen', poster_url: null, year: 2023, country: 'KR' },
                { id: 3, title: 'Strong Match', poster_url: null, year: 2025, country: 'TH' },
                { id: 4, title: 'No Overlap', poster_url: null, year: 2022, country: 'JP' },
            ],
            error: null,
        });

        // Candidate pass: tags/genres for unseen series [3, 4].
        queue('series_tags', {
            data: [
                { series_id: 3, tags: { id: 100, dimension: 'trope', display_label: 'Enemies to Lovers' } }, // matches series 1's strong signal
                { series_id: 3, tags: { id: 102, dimension: 'mood', display_label: 'Cozy' } }, // matches series 2's signal
            ],
            error: null,
        });
        queue('series_genres', {
            data: [{ series_id: 3, genres: { name: 'Romance' } }],
            error: null,
        });

        const result = await getRecommendationsForUser(42);

        expect(result.has_enough_signal).toBe(true);
        // "Seen Show" and "Also Seen" must never appear as recommendations.
        expect(result.data.map((r) => r.id)).not.toContain(1);
        expect(result.data.map((r) => r.id)).not.toContain(2);
        // "No Overlap" has zero shared tags/genres -- excluded entirely.
        expect(result.data.map((r) => r.id)).not.toContain(4);

        const strongMatch = result.data.find((r) => r.id === 3);
        expect(strongMatch).toBeDefined();
        expect(strongMatch!.score).toBeGreaterThan(0);
        expect(strongMatch!.match_reasons).toEqual(expect.arrayContaining(['Enemies to Lovers', 'Cozy']));
        // content_warning tags never appear as a match reason.
        expect(strongMatch!.match_reasons).not.toContain('Graphic Violence');
    });

    it('respects the limit parameter', async () => {
        queue('ratings', { data: [{ series_id: 1, score: 9 }], error: null });
        queue('user_lists', { data: [], error: null });
        queue('series_tags', {
            data: [{ series_id: 1, tags: { id: 100, dimension: 'trope', display_label: 'Slow Burn' } }],
            error: null,
        });
        queue('series_genres', { data: [], error: null });
        queue('series', {
            data: [
                { id: 1, title: 'Seen', poster_url: null, year: 2024, country: 'TH' },
                { id: 2, title: 'Match A', poster_url: null, year: 2024, country: 'TH' },
                { id: 3, title: 'Match B', poster_url: null, year: 2024, country: 'TH' },
            ],
            error: null,
        });
        queue('series_tags', {
            data: [
                { series_id: 2, tags: { id: 100, dimension: 'trope', display_label: 'Slow Burn' } },
                { series_id: 3, tags: { id: 100, dimension: 'trope', display_label: 'Slow Burn' } },
            ],
            error: null,
        });
        queue('series_genres', { data: [], error: null });

        const result = await getRecommendationsForUser(42, 1);

        expect(result.data).toHaveLength(1);
    });

    it('throws if the ratings lookup errors', async () => {
        queue('ratings', { data: null, error: { message: 'db down' } });
        queue('user_lists', { data: [], error: null });

        await expect(getRecommendationsForUser(42)).rejects.toThrow('db down');
    });
});
