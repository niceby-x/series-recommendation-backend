// src/services/curatorPicks.ts
//
// Shared shape-builder for curator picks -- both the public curator-picks
// router and the admin curator-picks router join the same series/genre/tags
// data, so this keeps that one join/flatten in one place instead of
// duplicated inline twice (moved out of index.ts as part of the P4-04 split).

import { supabase } from './supabase';

// Shared shape-builder for curator picks -- both the public and admin
// routes below join the same series/genre/tags data, so this keeps that
// one join/flatten in one place instead of duplicated inline twice.
export async function fetchCuratorPicksJoined() {
    const { data, error } = await supabase
        .from('curator_picks')
        .select(
            'id, blurb, is_feature, sort_order, series (id, title, country, year, poster_url, backdrop_url, ' +
            'series_genres (genres (name)), series_tags (tags (display_label)))'
        )
        .order('is_feature', { ascending: false })
        .order('sort_order', { ascending: true });

    if (error || !data) return { error, data: [] as any[] };

    const seriesIds = data.map((p: any) => p.series?.id).filter(Boolean);

    // Real average rating per picked series, computed from actual
    // `ratings` rows -- these are meant to be genuinely featured titles
    // now, so this uses the real number instead of the deterministic mock
    // rating helper the rest of the catalog UI falls back to.
    const ratingsBySeries = new Map<number, number[]>();
    if (seriesIds.length > 0) {
        const { data: ratingsRows } = await supabase.from('ratings').select('series_id, score').in('series_id', seriesIds);
        for (const row of ratingsRows || []) {
            const list = ratingsBySeries.get(row.series_id) || [];
            list.push(row.score);
            ratingsBySeries.set(row.series_id, list);
        }
    }

    const shaped = data
        .filter((p: any) => p.series)
        .map((p: any) => {
            const scores = ratingsBySeries.get(p.series.id) || [];
            const avgRating = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
            // Real mood/trope tags if the series has any (series_tags),
            // otherwise fall back to genre names -- better than an empty
            // chip row for a series that's been genre-tagged but not yet
            // run through the newer tags picker in SeriesEditModal.
            const realTags = (p.series.series_tags || []).map((row: any) => row.tags?.display_label).filter(Boolean);
            const genreNames = (p.series.series_genres || []).map((row: any) => row.genres?.name).filter(Boolean);
            return {
                id: p.series.id,
                pick_id: p.id,
                title: p.series.title,
                country: p.series.country,
                mediaType: 'Series',
                year: p.series.year,
                rating: avgRating,
                tags: realTags.length > 0 ? realTags : genreNames,
                imageUrl: p.series.backdrop_url ?? p.series.poster_url,
                isFeature: p.is_feature,
                blurb: p.blurb,
            };
        });

    return { error: null, data: shaped };
}
