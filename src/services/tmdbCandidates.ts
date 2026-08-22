// src/services/tmdbCandidates.ts
//
// IMP5-01: TMDB detail-fetching, country/status resolution, and
// candidate-queuing logic -- previously private, non-reusable functions
// inside scripts/discover-series-by-keyword.ts. Extracted here so the new
// manual "search by title, pick one, add it" admin tool can queue a
// candidate through the exact same insert path as the bulk discovery
// script, rather than a second copy that could quietly drift out of sync
// with it (different field mapping, different status/country logic,
// etc.). The bulk script now imports from here instead of keeping its own
// copies -- this is a pure extraction, its behavior/log output is
// unchanged.

import { supabase } from './supabase';
import { TMDB_HEADERS, TMDB_BASE_URL } from './tmdb';

export type MediaType = 'tv' | 'movie';

const ANIMATION_GENRE_ID = 16;
const MAX_CAST_MEMBERS = 6;

// Same retry budget as the bulk script used inline -- kept identical
// rather than tuned differently for the manual path, since a single
// manual add hitting a 429 deserves the same "retry, don't just silently
// fail" treatment as a bulk-run request does.
const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

// Maps TMDB origin_country / production_countries codes to the country labels your `series` table uses.
const COUNTRY_CODE_LABELS: Record<string, string> = {
    TH: 'Thailand',
    KR: 'Korea',
    JP: 'Japan',
    TW: 'Taiwan',
    CN: 'China',
    HK: 'Hong Kong',
};

// Fallback when TMDB has no country data for a result — guesses from original_language instead.
const LANGUAGE_FALLBACK_LABELS: Record<string, string> = {
    th: 'Thailand',
    ko: 'Korea',
    ja: 'Japan',
    zh: 'China',
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps fetch with retry-with-backoff for TMDB 429s only -- any other
// status (including other errors) is returned as-is on the first try.
// Honors TMDB's Retry-After header when present, otherwise falls back to
// exponential backoff (1s, 2s, 4s).
export async function fetchWithRetry(url: string, context: string): Promise<Response> {
    let attempt = 0;

    while (true) {
        const res = await fetch(url, { headers: TMDB_HEADERS });

        if (res.status !== 429 || attempt >= MAX_429_RETRIES) {
            return res;
        }

        attempt++;
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
        const backoffMs = !Number.isNaN(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : BASE_BACKOFF_MS * Math.pow(2, attempt - 1);

        console.error('  ' + context + ' hit TMDB 429 — retrying in ' + backoffMs + 'ms (attempt ' + attempt + '/' + MAX_429_RETRIES + ')');
        await sleep(backoffMs);
    }
}

export interface TMDBCastMember {
    name: string;
    character: string;
    profile_path: string | null;
}

// A result normalized from either /discover/{type} or /search/{type} into one common shape --
// both endpoints return the same per-item fields, just under a different top-level list.
export interface NormalizedResult {
    tmdbId: number;
    title: string;
    originalTitle: string;
    overview: string;
    posterPath: string | null;
    backdropPath: string | null;
    year: number | null;
    originCountry: string[];
    originalLanguage: string;
    mediaType: MediaType;
    popularity: number;
}

// Details normalized from either /tv/{id} or /movie/{id} into one common shape.
export interface NormalizedDetails {
    episodeCount: number;
    numberOfSeasons: number | null;
    status: string;
    genres: { id: number; name: string }[];
    cast: TMDBCastMember[];
    countryCodes: string[];
}

function normalizeSearchOrDiscoverResults(results: any[], mediaType: MediaType): NormalizedResult[] {
    if (mediaType === 'tv') {
        return results.map((r) => ({
            tmdbId: r.id,
            title: r.name,
            originalTitle: r.original_name,
            overview: r.overview,
            posterPath: r.poster_path,
            backdropPath: r.backdrop_path,
            year: r.first_air_date ? parseInt(r.first_air_date.slice(0, 4)) : null,
            originCountry: r.origin_country || [],
            originalLanguage: r.original_language,
            mediaType: 'tv' as MediaType,
            popularity: r.popularity ?? 0,
        }));
    }

    return results.map((r) => ({
        tmdbId: r.id,
        title: r.title,
        originalTitle: r.original_title,
        overview: r.overview,
        posterPath: r.poster_path,
        backdropPath: r.backdrop_path,
        year: r.release_date ? parseInt(r.release_date.slice(0, 4)) : null,
        originCountry: [],
        originalLanguage: r.original_language,
        mediaType: 'movie' as MediaType,
        popularity: r.popularity ?? 0,
    }));
}

// Used by the bulk discovery script -- /discover/{type} filtered by keyword id, one page at a time.
export async function discoverPage(keywordId: number, mediaType: MediaType, page: number): Promise<NormalizedResult[]> {
    const endpoint = mediaType === 'tv' ? 'discover/tv' : 'discover/movie';
    const url = TMDB_BASE_URL + '/' + endpoint
        + '?with_keywords=' + keywordId
        + '&sort_by=popularity.desc'
        + '&page=' + page;

    const res = await fetchWithRetry(url, 'Discover request page ' + page + ' (' + mediaType + ')');

    if (!res.ok) {
        if (res.status === 429) {
            console.error('  Discover request failed on page ' + page + ' (' + mediaType + '): still rate-limited (429) after ' + MAX_429_RETRIES + ' retries — page skipped, not "no more results"');
        } else {
            console.error('  Discover request failed on page ' + page + ' (' + mediaType + '): ' + res.status);
        }
        return [];
    }

    const json = await res.json();
    console.log('  [debug] ' + mediaType + ' page ' + page + ': ' + (json.total_results ?? 0) + ' total results, ' + (json.results?.length ?? 0) + ' on this page');

    return normalizeSearchOrDiscoverResults(json.results || [], mediaType);
}

// IMP5-01: title search for the manual "search by title, pick one, add
// it" admin tool -- /search/{type} instead of /discover/{type}, no
// keyword id involved. Queries tv and movie in parallel and merges into
// one list sorted by TMDB's own popularity score, so the admin sees the
// most likely match first regardless of which media type it is. A failed
// request for one media type doesn't block the other -- e.g. if /search/tv
// 429s out, movie results still come back rather than the whole search
// failing.
export async function searchByTitle(query: string): Promise<NormalizedResult[]> {
    const [tvRes, movieRes] = await Promise.all([
        fetchWithRetry(TMDB_BASE_URL + '/search/tv?query=' + encodeURIComponent(query), 'Title search "' + query + '" (tv)'),
        fetchWithRetry(TMDB_BASE_URL + '/search/movie?query=' + encodeURIComponent(query), 'Title search "' + query + '" (movie)'),
    ]);

    const tvResults = tvRes.ok ? normalizeSearchOrDiscoverResults((await tvRes.json()).results || [], 'tv') : [];
    const movieResults = movieRes.ok ? normalizeSearchOrDiscoverResults((await movieRes.json()).results || [], 'movie') : [];

    if (!tvRes.ok) {
        console.error('  Title search "' + query + '" (tv) failed: ' + tvRes.status);
    }
    if (!movieRes.ok) {
        console.error('  Title search "' + query + '" (movie) failed: ' + movieRes.status);
    }

    return [...tvResults, ...movieResults].sort((a, b) => b.popularity - a.popularity);
}

function extractCast(json: any): TMDBCastMember[] {
    return (json.credits?.cast || [])
        .slice(0, MAX_CAST_MEMBERS)
        .map((c: { name: string; character: string; profile_path: string | null }) => ({
            name: c.name,
            character: c.character,
            profile_path: c.profile_path,
        }));
}

export async function getDetails(tmdbId: number, mediaType: MediaType): Promise<NormalizedDetails | null> {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = TMDB_BASE_URL + '/' + endpoint + '/' + tmdbId + '?append_to_response=credits';

    const res = await fetchWithRetry(url, 'Details lookup for TMDB id ' + tmdbId + ' (' + mediaType + ')');

    if (!res.ok) {
        if (res.status === 429) {
            console.error('  Details lookup failed for TMDB id ' + tmdbId + ' (' + mediaType + '): still rate-limited (429) after ' + MAX_429_RETRIES + ' retries — skipped');
        } else {
            console.error('  Details lookup failed for TMDB id ' + tmdbId + ' (' + mediaType + '): ' + res.status);
        }
        return null;
    }

    const json = await res.json();
    const cast = extractCast(json);

    if (mediaType === 'tv') {
        return {
            episodeCount: json.number_of_episodes ?? 0,
            numberOfSeasons: json.number_of_seasons ?? null,
            status: json.status || 'Unknown',
            genres: json.genres || [],
            cast,
            countryCodes: [],
        };
    }

    const countryCodes = (json.production_countries || []).map((c: { iso_3166_1: string }) => c.iso_3166_1);

    return {
        episodeCount: 1,
        numberOfSeasons: null,
        status: json.status || 'Unknown',
        genres: json.genres || [],
        cast,
        countryCodes,
    };
}

// IMP5-01: single detail-endpoint fetch returning everything needed to
// queue a candidate by tmdb id alone -- both the identifying/display
// fields (title, poster, overview, year, ...) getDetails() above doesn't
// return, and the same details fields getDetails() already extracts.
// Used by the manual add-by-tmdb-id route so it only ever needs a tmdb id
// + media type from the client, rather than trusting client-supplied
// title/poster/etc. that could be stale by the time "Add" is clicked (or
// simply tampered with, since this is the field set that gets written to
// the DB). One TMDB request either way -- /tv/{id} and /movie/{id} already
// include both field sets in a single response.
export async function getFullRecordForAdd(
    tmdbId: number,
    mediaType: MediaType
): Promise<{ result: NormalizedResult; details: NormalizedDetails } | null> {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = TMDB_BASE_URL + '/' + endpoint + '/' + tmdbId + '?append_to_response=credits';

    const res = await fetchWithRetry(url, 'Add-by-id lookup for TMDB id ' + tmdbId + ' (' + mediaType + ')');

    if (!res.ok) {
        return null;
    }

    const json = await res.json();
    const cast = extractCast(json);

    if (mediaType === 'tv') {
        return {
            result: {
                tmdbId: json.id,
                title: json.name,
                originalTitle: json.original_name,
                overview: json.overview,
                posterPath: json.poster_path,
                backdropPath: json.backdrop_path,
                year: json.first_air_date ? parseInt(json.first_air_date.slice(0, 4)) : null,
                originCountry: json.origin_country || [],
                originalLanguage: json.original_language,
                mediaType: 'tv',
                popularity: json.popularity ?? 0,
            },
            details: {
                episodeCount: json.number_of_episodes ?? 0,
                numberOfSeasons: json.number_of_seasons ?? null,
                status: json.status || 'Unknown',
                genres: json.genres || [],
                cast,
                countryCodes: [],
            },
        };
    }

    const countryCodes = (json.production_countries || []).map((c: { iso_3166_1: string }) => c.iso_3166_1);

    return {
        result: {
            tmdbId: json.id,
            title: json.title,
            originalTitle: json.original_title,
            overview: json.overview,
            posterPath: json.poster_path,
            backdropPath: json.backdrop_path,
            year: json.release_date ? parseInt(json.release_date.slice(0, 4)) : null,
            originCountry: [],
            originalLanguage: json.original_language,
            mediaType: 'movie',
            popularity: json.popularity ?? 0,
        },
        details: {
            episodeCount: 1,
            numberOfSeasons: null,
            status: json.status || 'Unknown',
            genres: json.genres || [],
            cast,
            countryCodes,
        },
    };
}

// Resolves a result's real-world country: prefers country codes (origin_country for TV,
// production_countries for movies), falls back to original_language, falls back to "Other".
export function resolveCountry(countryCodes: string[], originalLanguage: string): string {
    for (const code of countryCodes) {
        if (COUNTRY_CODE_LABELS[code]) {
            return COUNTRY_CODE_LABELS[code];
        }
    }

    if (LANGUAGE_FALLBACK_LABELS[originalLanguage]) {
        return LANGUAGE_FALLBACK_LABELS[originalLanguage];
    }

    return 'Other';
}

export function mapStatus(mediaType: MediaType, tmdbStatus: string): string {
    if (mediaType === 'movie') {
        return 'completed';
    }

    if (tmdbStatus === 'Ended' || tmdbStatus === 'Canceled') {
        return 'completed';
    }
    return 'airing';
}

export function isAnimated(genres: { id: number; name: string }[]): boolean {
    return genres.some((g) => g.id === ANIMATION_GENRE_ID);
}

// IMP5-01: batched existence check against both series and
// series_candidates, scoped to just the tmdb ids the caller actually
// cares about via .in(...) -- unlike the bulk script's fetchAllRows,
// which loads every row once per run because it's dedupe-checking
// hundreds of discover results against the whole catalog. A title search
// only ever returns ~20 results at a time, so a targeted query is cheaper
// than pulling the whole table for that.
export async function findExistingTmdbIds(tmdbIds: number[]): Promise<Set<number>> {
    if (tmdbIds.length === 0) {
        return new Set();
    }

    const [seriesRes, candidatesRes] = await Promise.all([
        supabase.from('series').select('tmdb_id').in('tmdb_id', tmdbIds),
        supabase.from('series_candidates').select('tmdb_id').in('tmdb_id', tmdbIds),
    ]);

    const ids = new Set<number>();
    (seriesRes.data || []).forEach((r: { tmdb_id: number | null }) => r.tmdb_id && ids.add(r.tmdb_id));
    (candidatesRes.data || []).forEach((r: { tmdb_id: number | null }) => r.tmdb_id && ids.add(r.tmdb_id));
    return ids;
}

export interface CandidateUpsertResult {
    status: 'queued' | 'duplicate' | 'error';
    message?: string;
    id?: number;
}

// IMP5-01: the actual series_candidates insert -- same shape/upsert
// options the bulk script has always used (onConflict: 'tmdb_id',
// ignoreDuplicates: true), now shared so the manual add-by-id route
// writes through this exact path instead of a parallel implementation
// that could silently diverge on a field mapping. sourceKeyword is
// caller-supplied so callers can tell manually-added candidates apart
// from discovery-sourced ones (e.g. 'manual: title search' vs a real
// discovery keyword) without a schema change -- source_keyword already
// accepts arbitrary text.
export async function upsertCandidate(
    result: NormalizedResult,
    details: NormalizedDetails | null,
    sourceKeyword: string
): Promise<CandidateUpsertResult> {
    if (!result.title || !result.posterPath) {
        return { status: 'error', message: 'Missing title or poster image -- TMDB has incomplete data for this result' };
    }

    const episodeCount = details?.episodeCount ?? (result.mediaType === 'movie' ? 1 : 0);
    const status = details ? mapStatus(result.mediaType, details.status) : 'completed';
    const countryCodes = result.mediaType === 'tv' ? result.originCountry : (details?.countryCodes || []);
    const resolvedCountry = resolveCountry(countryCodes, result.originalLanguage);
    const animated = details ? isAnimated(details.genres) : false;
    const numberOfSeasons = details?.numberOfSeasons ?? null;
    const genreNames = details ? details.genres.map((g) => g.name) : [];
    const castJson = details
        ? details.cast.map((c) => ({
            name: c.name,
            character: c.character,
            photo_url: c.profile_path ? 'https://image.tmdb.org/t/p/w200' + c.profile_path : null,
        }))
        : [];

    const { error, data } = await supabase
        .from('series_candidates')
        .upsert([{
            title: result.title,
            original_title: result.originalTitle || null,
            country: resolvedCountry,
            year: result.year,
            episode_count: episodeCount,
            status: status,
            synopsis: result.overview || '',
            poster_url: 'https://image.tmdb.org/t/p/w500' + result.posterPath,
            backdrop_url: result.backdropPath ? 'https://image.tmdb.org/t/p/w1280' + result.backdropPath : null,
            tmdb_id: result.tmdbId,
            source_keyword: sourceKeyword,
            review_status: 'pending',
            is_animated: animated,
            number_of_seasons: numberOfSeasons,
            genre_names: genreNames,
            cast_json: castJson,
            media_type: result.mediaType,
        }], { onConflict: 'tmdb_id', ignoreDuplicates: true })
        .select('id');

    if (error) {
        return { status: 'error', message: error.message };
    }
    if (!data || data.length === 0) {
        return { status: 'duplicate' };
    }
    return { status: 'queued', id: data[0].id };
}
