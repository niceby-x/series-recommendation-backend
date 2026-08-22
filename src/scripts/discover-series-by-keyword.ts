import { supabase } from '../services/supabase';
// IMP5-01: getDetails/resolveCountry/mapStatus/discoverPage/fetchWithRetry/
// isAnimated/upsertCandidate/NormalizedResult now live in
// services/tmdbCandidates.ts, shared with the new manual "search by
// title" admin route -- this script imports them instead of keeping its
// own private copies. Behavior and log output here are unchanged; this is
// a pure extraction.
import {
    MediaType,
    NormalizedResult,
    discoverPage,
    getDetails,
    resolveCountry,
    mapStatus,
    isAnimated,
    upsertCandidate,
} from '../services/tmdbCandidates';
import { TMDB_HEADERS } from '../services/tmdb';

// Safety cap on how many TMDB result pages to walk through per media type in one run (20 results per page).
const MAX_PAGES = 50;

// Safety cap on how many new candidates to queue in one run (across both TV and movies combined),
// so a single run stays reviewable. Override with --limit=300 on the command line.
const DEFAULT_LIMIT = 150;

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

// Looks up the TMDB keyword id for the given query. Known-id fallback
// and the "(bl)"-suffix matching only apply to DEFAULT_KEYWORD -- both
// preserve this script's original behavior exactly for its built-in
// keyword; a custom keyword has no equivalent fallback id or suffix
// convention to rely on, so it's searched and matched verbatim, aborting
// the run (like a failed HTTP request would) if TMDB has no match for it.
// The same keyword id works for both /discover/tv and /discover/movie,
// since TMDB keywords are shared across media types. Not extracted to
// services/tmdbCandidates.ts (unlike discoverPage/getDetails/etc.) since
// this is keyword-lookup logic specific to the bulk discovery flow -- the
// manual search-by-title tool (IMP5-01) doesn't use TMDB keywords at all.
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
                // IMP5-01: renamed from `isAnimated` to `animated` -- the
                // imported isAnimated(genres) function (services/tmdbCandidates.ts)
                // would otherwise be shadowed by a same-named local const
                // in this scope.
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

                if (DRY_RUN) {
                    console.log('  [DRY RUN] Would queue "' + result.title + '" [' + mediaType + '] (' + resolvedCountry + ', ' + result.year + ', '
                        + episodeCount + ' eps, ' + numberOfSeasons + ' seasons, ' + status + (animated ? ', ANIMATED' : '') + ', '
                        + genreNames.join('/') + ', cast: ' + castJson.map((c) => c.name).join(', ') + ')');
                    countryTally[resolvedCountry] = (countryTally[resolvedCountry] || 0) + 1;
                    mediaTypeTally[mediaType]++;
                    added++;
                    addedForType++;
                    existingTitles.add(result.title);
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    continue;
                }

                // IMP5-01: writes through the same upsertCandidate
                // (services/tmdbCandidates.ts) the new manual add-by-id
                // route uses, instead of building the insert object here
                // directly -- one insert-shape implementation instead of
                // two that could drift apart. Log wording/tally updates
                // below are unchanged from before this refactor.
                const upsertResult = await upsertCandidate(result, details, SOURCE_KEYWORD);

                if (upsertResult.status === 'error') {
                    console.error('  Failed to queue "' + result.title + '": ' + upsertResult.message);
                } else if (upsertResult.status === 'duplicate') {
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