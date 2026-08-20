import { supabase } from '../services/supabase';
import { TMDB_HEADERS } from '../services/tmdb';

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

// Safety cap on how many TMDB result pages to walk through per media type in one run (20 results per page).
const MAX_PAGES = 50;

// Safety cap on how many new candidates to queue in one run (across both TV and movies combined),
// so a single run stays reviewable. Override with --limit=300 on the command line.
const DEFAULT_LIMIT = 150;

const DRY_RUN = process.argv.includes('--dry-run');
let SOURCE_KEYWORD = "boys' love (bl)";

type MediaType = 'tv' | 'movie';

const ANIMATION_GENRE_ID = 16;
const MAX_CAST_MEMBERS = 6;

interface TMDBCastMember {
    name: string;
    character: string;
    profile_path: string | null;
}

// A result normalized from either /discover/tv or /discover/movie into one common shape.
interface NormalizedResult {
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
}

// Details normalized from either /tv/{id} or /movie/{id} into one common shape.
interface NormalizedDetails {
    episodeCount: number;
    numberOfSeasons: number | null;
    status: string;
    genres: { id: number; name: string }[];
    cast: TMDBCastMember[];
    countryCodes: string[];
}

// Look up the TMDB keyword ID for "boys' love (bl)". Known id is 289844, but we still
// search by name to stay resilient if TMDB ever changes ids. The same keyword id works
// for both /discover/tv and /discover/movie, since TMDB keywords are shared across media types.
async function getBoysLoveKeywordId(): Promise<number | null> {
    const url = 'https://api.themoviedb.org/3/search/keyword?query=' + encodeURIComponent("boys' love");

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        console.error('Keyword lookup failed: ' + res.status);
        return null;
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        console.error('No TMDB keyword found for "boys\' love" — falling back to known id 289844');
        return 289844;
    }

    const exactMatch = json.results.find((k: { name: string }) => k.name.toLowerCase().includes('(bl)'));
    const match = exactMatch || json.results[0];

    console.log('Using keyword "' + match.name + '" (id ' + match.id + ')\n');

    SOURCE_KEYWORD = match.name;
    return match.id;
}

async function discoverPage(keywordId: number, mediaType: MediaType, page: number): Promise<NormalizedResult[]> {
    const endpoint = mediaType === 'tv' ? 'discover/tv' : 'discover/movie';
    const url = 'https://api.themoviedb.org/3/' + endpoint
        + '?with_keywords=' + keywordId
        + '&sort_by=popularity.desc'
        + '&page=' + page;

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        console.error('  Discover request failed on page ' + page + ' (' + mediaType + '): ' + res.status);
        return [];
    }

    const json = await res.json();
    console.log('  [debug] ' + mediaType + ' page ' + page + ': ' + (json.total_results ?? 0) + ' total results, ' + (json.results?.length ?? 0) + ' on this page');

    const results = json.results || [];

    if (mediaType === 'tv') {
        return results.map((r: any) => ({
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
        }));
    }

    return results.map((r: any) => ({
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
    }));
}

async function getDetails(tmdbId: number, mediaType: MediaType): Promise<NormalizedDetails | null> {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = 'https://api.themoviedb.org/3/' + endpoint + '/' + tmdbId + '?append_to_response=credits';

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        return null;
    }

    const json = await res.json();

    const cast: TMDBCastMember[] = (json.credits?.cast || [])
        .slice(0, MAX_CAST_MEMBERS)
        .map((c: { name: string; character: string; profile_path: string | null }) => ({
            name: c.name,
            character: c.character,
            profile_path: c.profile_path,
        }));

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

// Resolves a result's real-world country: prefers country codes (origin_country for TV,
// production_countries for movies), falls back to original_language, falls back to "Other".
function resolveCountry(countryCodes: string[], originalLanguage: string): string {
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

function mapStatus(mediaType: MediaType, tmdbStatus: string): string {
    if (mediaType === 'movie') {
        return 'completed';
    }

    if (tmdbStatus === 'Ended' || tmdbStatus === 'Canceled') {
        return 'completed';
    }
    return 'airing';
}

function parseLimitArg(): number {
    const arg = process.argv.find((a) => a.startsWith('--limit='));
    if (!arg) return DEFAULT_LIMIT;
    const parsed = parseInt(arg.split('=')[1]);
    return isNaN(parsed) ? DEFAULT_LIMIT : parsed;
}

// Supabase/PostgREST caps a single unpaginated select() at 1000 rows by default.
// series/series_candidates can easily exceed that, which was silently truncating
// the dedupe set below and causing "Failed to queue" unique-constraint errors for
// titles that were already in the DB but past row #1000. Page through with .range()
// instead so the dedupe set is always complete regardless of table size.
async function fetchAllRows(table: 'series' | 'series_candidates'): Promise<{ title: string; tmdb_id: number | null }[]> {
    const PAGE_SIZE = 1000;
    let all: { title: string; tmdb_id: number | null }[] = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from(table)
            .select('title, tmdb_id')
            .range(from, from + PAGE_SIZE - 1);

        if (error) {
            throw new Error('Could not load ' + table + ': ' + error.message);
        }

        if (!data || data.length === 0) {
            break;
        }

        all = all.concat(data);

        if (data.length < PAGE_SIZE) {
            break;
        }

        from += PAGE_SIZE;
    }

    return all;
}

async function run() {
    if (DRY_RUN) {
        console.log('Running in DRY RUN mode — nothing will be written to Supabase.\n');
    }

    const limit = parseLimitArg();
    console.log('Run limit: ' + limit + ' new candidates per media type (TV and Movies each get their own budget) — override with --limit=N\n');

    const keywordId = await getBoysLoveKeywordId();

    if (!keywordId) {
        console.error('Could not resolve a keyword id, aborting.');
        return;
    }

    let existingSeries: { title: string; tmdb_id: number | null }[];
    let existingCandidates: { title: string; tmdb_id: number | null }[];

    try {
        existingSeries = await fetchAllRows('series');
        existingCandidates = await fetchAllRows('series_candidates');
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return;
    }

    const existingTitles = new Set([
        ...existingSeries.map((r) => r.title),
        ...existingCandidates.map((r) => r.title),
    ]);
    const existingTmdbIds = new Set([
        ...existingSeries.filter((r) => r.tmdb_id).map((r) => r.tmdb_id),
        ...existingCandidates.filter((r) => r.tmdb_id).map((r) => r.tmdb_id),
    ]);

    console.log('Loaded ' + existingSeries.length + ' catalog series and ' + existingCandidates.length + ' existing candidates for dedupe.\n');

    const countryTally: Record<string, number> = {};
    const mediaTypeTally: Record<string, number> = { tv: 0, movie: 0 };
    let added = 0;

    for (const mediaType of ['tv', 'movie'] as MediaType[]) {
        console.log('\n=== Searching ' + mediaType.toUpperCase() + ' ===');

        let page = 1;
        let addedForType = 0;

        while (addedForType < limit && page <= MAX_PAGES) {
            const results = await discoverPage(keywordId, mediaType, page);

            if (results.length === 0) {
                break;
            }

            for (const result of results) {
                if (addedForType >= limit) {
                    break;
                }

                if (!result.title || !result.posterPath) {
                    console.log('  [debug] skipping "' + (result.title || '(untitled)') + '" — missing title or poster');
                    continue;
                }

                if (existingTmdbIds.has(result.tmdbId) || existingTitles.has(result.title)) {
                    console.log('  Skipping "' + result.title + '" (already queued or in catalog)');
                    continue;
                }

                const details = await getDetails(result.tmdbId, mediaType);

                const episodeCount = details?.episodeCount ?? (mediaType === 'movie' ? 1 : 0);
                const status = details ? mapStatus(mediaType, details.status) : 'completed';
                const countryCodes = mediaType === 'tv' ? result.originCountry : (details?.countryCodes || []);
                const resolvedCountry = resolveCountry(countryCodes, result.originalLanguage);
                const isAnimated = details ? details.genres.some((g) => g.id === ANIMATION_GENRE_ID) : false;
                const numberOfSeasons = details?.numberOfSeasons ?? null;
                const genreNames = details ? details.genres.map((g) => g.name) : [];
                const castJson = details
                    ? details.cast.map((c) => ({
                        name: c.name,
                        character: c.character,
                        photo_url: c.profile_path ? 'https://image.tmdb.org/t/p/w200' + c.profile_path : null,
                    }))
                    : [];

                if (DRY_RUN) {
                    console.log('  [DRY RUN] Would queue "' + result.title + '" [' + mediaType + '] (' + resolvedCountry + ', ' + result.year + ', '
                        + episodeCount + ' eps, ' + numberOfSeasons + ' seasons, ' + status + (isAnimated ? ', ANIMATED' : '') + ', '
                        + genreNames.join('/') + ', cast: ' + castJson.map((c) => c.name).join(', ') + ')');
                    countryTally[resolvedCountry] = (countryTally[resolvedCountry] || 0) + 1;
                    mediaTypeTally[mediaType]++;
                    added++;
                    addedForType++;
                    existingTitles.add(result.title);
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    continue;
                }

                const { error: insertError, data: insertData } = await supabase
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
                        source_keyword: SOURCE_KEYWORD,
                        review_status: 'pending',
                        is_animated: isAnimated,
                        number_of_seasons: numberOfSeasons,
                        genre_names: genreNames,
                        cast_json: castJson,
                        media_type: mediaType,
                    }], { onConflict: 'tmdb_id', ignoreDuplicates: true })
                    .select('id');

                if (insertError) {
                    console.error('  Failed to queue "' + result.title + '": ' + insertError.message);
                } else if (!insertData || insertData.length === 0) {
                    // ignoreDuplicates means the row already existed (e.g. a concurrent run,
                    // or something our in-memory dedupe set missed) — treat as a normal skip.
                    console.log('  Skipping "' + result.title + '" (tmdb_id already exists — caught at insert time)');
                    existingTitles.add(result.title);
                    existingTmdbIds.add(result.tmdbId);
                } else {
                    console.log('  Queued "' + result.title + '" [' + mediaType + '] (' + resolvedCountry + ', ' + result.year + ') for review');
                    countryTally[resolvedCountry] = (countryTally[resolvedCountry] || 0) + 1;
                    mediaTypeTally[mediaType]++;
                    added++;
                    addedForType++;
                    existingTitles.add(result.title);
                    existingTmdbIds.add(result.tmdbId);
                }

                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            page++;
        }
    }

    console.log('\n=== Summary ===');
    console.log(added + ' new candidates ' + (DRY_RUN ? 'would be queued' : 'queued for review') + ' total:');
    console.log('  TV: ' + mediaTypeTally.tv + ', Movies: ' + mediaTypeTally.movie);
    for (const [country, count] of Object.entries(countryTally)) {
        console.log('  ' + country + ': ' + count);
    }

    console.log('\nDone.');
}

run();