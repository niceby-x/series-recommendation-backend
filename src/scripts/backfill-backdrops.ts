// src/backfill-backdrops.ts
//
// One-time (or re-run-safe) backfill for the new `backdrop_url` column.
// Only touches rows where backdrop_url IS NULL, so it's safe to run more
// than once — already-filled rows are skipped.
//
// Two lookup strategies, in priority order:
//   1. Exact lookup via tmdb_id + media_type (GET /tv/{id} or /movie/{id}).
//      This is precise — no ambiguity — and works for every row inserted
//      through the candidate-review pipeline, since those already store
//      tmdb_id. Rows with a placeholder (negative) tmdb_id — see
//      backfill-approved-candidates.ts — don't qualify and fall through to:
//   2. Title + year search (same best-guess pattern as fetch-posters.ts),
//      for older rows that predate tmdb_id being tracked.
//
// Usage:
//   npx tsx src/scripts/backfill-backdrops.ts            (writes to Supabase)
//   npx tsx src/scripts/backfill-backdrops.ts --dry-run   (prints what it would do)

import { supabase } from '../services/supabase';
import { TMDB_HEADERS } from '../services/tmdb';

const DRY_RUN = process.argv.includes('--dry-run');

interface SeriesRow {
    id: number;
    title: string;
    year: number;
    tmdb_id: number | null;
    media_type: 'tv' | 'movie' | null;
}

function toBackdropUrl(backdropPath: string | null): string | null {
    // w1280 — a good balance of quality vs size for a full-width hero image.
    return backdropPath ? 'https://image.tmdb.org/t/p/w1280' + backdropPath : null;
}

async function backdropByTmdbId(tmdbId: number, mediaType: 'tv' | 'movie'): Promise<string | null> {
    const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
    const url = 'https://api.themoviedb.org/3/' + endpoint + '/' + tmdbId;

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        console.error('  TMDB lookup failed for tmdb_id ' + tmdbId + ': ' + res.status);
        return null;
    }

    const json = await res.json();
    return toBackdropUrl(json.backdrop_path ?? null);
}

async function backdropByTitleSearch(title: string, year: number): Promise<string | null> {
    const url = 'https://api.themoviedb.org/3/search/tv?query=' + encodeURIComponent(title)
        + '&first_air_date_year=' + year;

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        console.error('  TMDB search failed for "' + title + '": ' + res.status);
        return null;
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        console.log('  No TMDB results found for "' + title + '" (' + year + ')');
        return null;
    }

    return toBackdropUrl(json.results[0].backdrop_path ?? null);
}

async function run() {
    if (DRY_RUN) {
        console.log('Running in DRY RUN mode — nothing will be written to Supabase.\n');
    }

    const { data: seriesList, error } = await supabase
        .from('series')
        .select('id, title, year, tmdb_id, media_type')
        .is('backdrop_url', null);

    if (error) {
        console.error('Failed to fetch series from Supabase: ' + error.message);
        return;
    }

    console.log('Found ' + seriesList.length + ' series missing a backdrop_url.\n');

    let updated = 0;
    let skipped = 0;

    for (const series of seriesList as SeriesRow[]) {
        console.log('Processing: "' + series.title + '" (' + series.year + ')');

        // A placeholder tmdb_id (see backfill-approved-candidates.ts) is always
        // negative — real TMDB ids are always positive — so this correctly
        // routes placeholder rows to the title-search fallback instead.
        const hasRealTmdbId = typeof series.tmdb_id === 'number' && series.tmdb_id > 0;

        const backdropUrl = hasRealTmdbId
            ? await backdropByTmdbId(series.tmdb_id as number, series.media_type ?? 'tv')
            : await backdropByTitleSearch(series.title, series.year);

        if (!backdropUrl) {
            console.log('  No backdrop found, skipping.\n');
            skipped++;
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
        }

        if (DRY_RUN) {
            console.log('  [DRY RUN] Would save backdrop: ' + backdropUrl + '\n');
            updated++;
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
        }

        const { error: updateError } = await supabase
            .from('series')
            .update({ backdrop_url: backdropUrl })
            .eq('id', series.id);

        if (updateError) {
            console.error('  Failed to save backdrop: ' + updateError.message + '\n');
            skipped++;
        } else {
            console.log('  Saved backdrop: ' + backdropUrl + '\n');
            updated++;
        }

        // Small delay to stay well within TMDB's rate limits
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log(
        '\nDone. ' + updated + ' series ' + (DRY_RUN ? 'would be' : 'were') + ' updated, '
        + skipped + ' skipped (no match found).'
    );
}

run();
