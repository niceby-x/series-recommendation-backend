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

// IMP3-04: discoverPage() and getDetails() previously just checked res.ok
// and logged-and-skipped on any failure, so a TMDB 429 mid-run silently
// dropped whatever page/detail it hit -- indistinguishable in the log from
// "no more results" or a real error. This retries 429s with backoff before
// giving up, and the final skip log (below) says explicitly that it's a
// rate-limit skip, not a "ran out of results" skip.
const MAX_429_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps fetch with retry-with-backoff for TMDB 429s only -- any other
// status (including other errors) is returned as-is on the first try,
// same as before, since only rate limiting is transient in a way retrying
// helps with. Honors TMDB's Retry-After header when present, otherwise
// falls back to exponential backoff (1s, 2s, 4s).
async function fetchWithRetry(url: string, context: string): Promise<Response> {
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

const DRY_RUN = process.argv.includes('--dry-run');

// IMP3-02: was previously the only keyword this script could ever search
// for -- now the default when --keyword isn't passed (see
// parseKeywordArg), not the only option. Kept as a named constant rather
// than an inline string since getKeywordId's fallback-to-known-id path
// below only applies when running with this exact default, not an
// arbitrary custom keyword.
const DEFAULT_KEYWORD = "boys' love (bl)";
// TMDB's id for DEFAULT_KEYWORD, used only as a last-resort fallback if a
// live lookup for the default keyword comes back empty (e.g. a transient
// TMDB API hiccup) -- there's no equivalent fallback id for a custom
// keyword, since there's nothing to fall back to.
const KNOWN_DEFAULT_KEYWORD_ID = 289844;
let SOURCE_KEYWORD = DEFAULT_KEYWORD;

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

// Looks up the TMDB keyword id for the given query. Known-id fallback
// and the "(bl)"-suffix matching only apply to DEFAULT_KEYWORD -- both
// preserve this script's original behavior exactly for its built-in
// keyword; a custom keyword has no equivalent fallback id or suffix
// convention to rely on, so it's searched and matched verbatim, aborting
// the run (like a failed HTTP request would) if TMDB has no match for it.
// The same keyword id works for both /discover/tv and /discover/movie,
// since TMDB keywords are shared across media types.
async function getKeywordId(query: string): Promise<number | null> {
    const isDefaultKeyword = query === DEFAULT_KEYWORD;
    // TMDB's keyword search matches better against the bare phrase than
    // one with a parenthetical suffix -- for the default keyword this
    // strips "(bl)" before searching, same as this script always has,
    // relying on the exact-match check below to pick the "(bl)" result
    // back out of TMDB's results. A custom keyword has no such suffix
    // convention to strip, so it's searched exactly as given.
    const searchQuery = isDefaultKeyword ? "boys' love" : query;
    const url = 'https://api.themoviedb.org/3/search/keyword?query=' + encodeURIComponent(searchQuery);

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        console.error('Keyword lookup failed: ' + res.status);
        return null;
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        if (isDefaultKeyword) {
            console.error('No TMDB keyword found for "' + searchQuery + '" — falling back to known id ' + KNOWN_DEFAULT_KEYWORD_ID);
            SOURCE_KEYWORD = query;
            return KNOWN_DEFAULT_KEYWORD_ID;
        }
        console.error('No TMDB keyword found for "' + query + '"');
        return null;
    }

    const exactMatch = isDefaultKeyword
        ? json.results.find((k: { name: string }) => k.name.toLowerCase().includes('(bl)'))
        : json.results.find((k: { name: string }) => k.name.toLowerCase() === query.toLowerCase());
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

// IMP3-02: mirrors parseLimitArg above -- --keyword=<value> overrides the
// built-in default. Slices off just the "--keyword=" prefix (fixed
// length) rather than split('=')[1], since a keyword can itself contain
// "=" in principle and split would otherwise truncate at the first one.
// An empty/whitespace-only value (e.g. a caller passing --keyword= with
// nothing after it) falls back to the default rather than sending an
// empty query to TMDB.
function parseKeywordArg(): string {
    const arg = process.argv.find((a) => a.startsWith('--keyword='));
    if (!arg) return DEFAULT_KEYWORD;
    const value = arg.slice('--keyword='.length).trim();
    return value.length > 0 ? value : DEFAULT_KEYWORD;
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

    const keyword = parseKeywordArg();
    console.log('Discovery keyword: "' + keyword + '" — override with --keyword=<name> (default: "' + DEFAULT_KEYWORD + '")\n');

    const keywordId = await getKeywordId(keyword);

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

                // IMP1-06: previously one combined check/log line for
                // both cases -- couldn't tell a correct skip (TMDB
                // re-surfacing a show already known by tmdb_id, expected
                // when overlapping keywords like "boys' love (bl)" and
                // "gay romance" rediscover the same shows) apart from a
                // title-only collision (a DIFFERENT tmdb_id whose title
                // string happens to already exist somewhere in
                // series/series_candidates -- existingTitles is built
                // from the whole table, not scoped to this run's genre,
                // so a generic title like "Bro" or "Tonight" can false-
                // positive against an unrelated existing row). Split so a
                // run's log makes that split visible instead of every
                // skip looking identical.
                if (existingTmdbIds.has(result.tmdbId)) {
                    console.log('  Skipping "' + result.title + '" (tmdb_id ' + result.tmdbId + ' already in catalog/queue)');
                    continue;
                }
                if (existingTitles.has(result.title)) {
                    console.log('  Skipping "' + result.title + '" (title collision, tmdb_id ' + result.tmdbId + ' is NEW -- possible false positive, verify against the existing row with this title)');
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

    // IMP3-01: everything above is human-readable log output -- fine for
    // a CLI run, but the admin page previously had no structured way to
    // show these tallies without scrolling raw log text, and a future
    // run-history view (IMP3-03) needs the same numbers per past row,
    // not just the most recent run's log. This single line is the
    // machine-readable counterpart: same countryTally/mediaTypeTally
    // numbers already computed above, just also emitted as one parseable
    // JSON line rather than only formatted for a human. The
    // __IMPORT_SUMMARY__ prefix lets services/importRuns.ts's stdout
    // handler pick this one line out of the rest of the log tail
    // (appendImportLog strips it back out before it reaches the visible
    // log) without needing a separate IPC channel -- stdout is already
    // being piped and parsed for the log tail either way.
    console.log('__IMPORT_SUMMARY__' + JSON.stringify({ added, mediaTypeTally, countryTally }));

    console.log('\nDone.');
}

run();