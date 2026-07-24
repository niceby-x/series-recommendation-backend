import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN as string;

// Maps TMDB origin_country codes to the country labels your `series` table uses.
const COUNTRY_CODE_LABELS: Record<string, string> = {
    TH: 'Thailand',
    KR: 'Korea',
    JP: 'Japan',
    TW: 'Taiwan',
    CN: 'China',
    HK: 'Hong Kong',
};

// Fallback when TMDB has no origin_country data for a result — guesses from original_language instead.
const LANGUAGE_FALLBACK_LABELS: Record<string, string> = {
    th: 'Thailand',
    ko: 'Korea',
    ja: 'Japan',
    zh: 'China',
};

// Safety cap on how many TMDB result pages to walk through in one run (20 results per page).
const MAX_PAGES = 50;

// Safety cap on how many new series to insert in one run, so a single run stays reviewable.
// Override with --limit=300 on the command line if you want a bigger harvest pass.
const DEFAULT_LIMIT = 150;

const TMDB_HEADERS = {
    Authorization: 'Bearer ' + TMDB_TOKEN,
    accept: 'application/json',
};

const DRY_RUN = process.argv.includes('--dry-run');
let SOURCE_KEYWORD = "boys' love (bl)";

interface TMDBDiscoverResult {
    id: number;
    name: string;
    original_name: string;
    overview: string;
    poster_path: string | null;
    first_air_date: string | null;
    origin_country: string[];
    original_language: string;
}

interface TMDBSeriesDetails {
    number_of_episodes: number | null;
    status: string;
}

// Look up the TMDB keyword ID for "boys' love (bl)" so we can filter /discover/tv by it.
// Known id is 289844, but we still search by name to stay resilient if TMDB ever changes ids.
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

async function discoverPage(keywordId: number, page: number): Promise<TMDBDiscoverResult[]> {
    const url = 'https://api.themoviedb.org/3/discover/tv'
        + '?with_keywords=' + keywordId
        + '&sort_by=popularity.desc'
        + '&page=' + page;

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        console.error('  Discover request failed on page ' + page + ': ' + res.status);
        return [];
    }

    const json = await res.json();
    console.log('  [debug] page ' + page + ': ' + (json.total_results ?? 0) + ' total results, ' + (json.results?.length ?? 0) + ' on this page');
    return json.results || [];
}

async function getSeriesDetails(tmdbId: number): Promise<TMDBSeriesDetails | null> {
    const url = 'https://api.themoviedb.org/3/tv/' + tmdbId;

    const res = await fetch(url, { headers: TMDB_HEADERS });

    if (!res.ok) {
        return null;
    }

    const json = await res.json();

    return {
        number_of_episodes: json.number_of_episodes ?? null,
        status: json.status || 'Unknown',
    };
}

// Resolves a TMDB result's real-world country: prefers origin_country, falls back to
// original_language, falls back to "Other" if neither maps to something we recognize.
function resolveCountry(originCountry: string[], originalLanguage: string): string {
    for (const code of originCountry) {
        if (COUNTRY_CODE_LABELS[code]) {
            return COUNTRY_CODE_LABELS[code];
        }
    }

    if (LANGUAGE_FALLBACK_LABELS[originalLanguage]) {
        return LANGUAGE_FALLBACK_LABELS[originalLanguage];
    }

    return 'Other';
}

function mapStatus(tmdbStatus: string): string {
    // TMDB uses statuses like "Ended", "Canceled", "Returning Series", "In Production".
    // Your table's existing convention is 'completed' / 'airing'.
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

async function run() {
    if (DRY_RUN) {
        console.log('Running in DRY RUN mode — nothing will be written to Supabase.\n');
    }

    const limit = parseLimitArg();
    console.log('Run limit: ' + limit + ' new candidates to queue (override with --limit=N)\n');

    const keywordId = await getBoysLoveKeywordId();

    if (!keywordId) {
        console.error('Could not resolve a keyword id, aborting.');
        return;
    }

    // Pull everything already in the catalog AND already-queued candidates once, up front,
    // instead of one round-trip per candidate. This way we never re-suggest something that's
    // already live, already pending review, or already rejected.
    const { data: existingSeries, error: existingSeriesError } = await supabase
        .from('series')
        .select('title, tmdb_id');

    if (existingSeriesError) {
        console.error('Could not load existing series: ' + existingSeriesError.message);
        return;
    }

    const { data: existingCandidates, error: existingCandidatesError } = await supabase
        .from('series_candidates')
        .select('title, tmdb_id');

    if (existingCandidatesError) {
        console.error('Could not load existing candidates: ' + existingCandidatesError.message);
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
    let added = 0;
    let page = 1;

    while (added < limit && page <= MAX_PAGES) {
        const results = await discoverPage(keywordId, page);

        if (results.length === 0) {
            break;
        }

        for (const result of results) {
            if (added >= limit) {
                break;
            }

            if (!result.name || !result.poster_path) {
                console.log('  [debug] skipping "' + (result.name || '(untitled)') + '" — missing name or poster');
                continue;
            }

            if (existingTmdbIds.has(result.id) || existingTitles.has(result.name)) {
                console.log('  Skipping "' + result.name + '" (already queued or in catalog)');
                continue;
            }

            const details = await getSeriesDetails(result.id);

            const year = result.first_air_date ? parseInt(result.first_air_date.slice(0, 4)) : null;
            const episodeCount = details?.number_of_episodes || 0;
            const status = details ? mapStatus(details.status) : 'completed';
            const resolvedCountry = resolveCountry(result.origin_country || [], result.original_language);

            if (DRY_RUN) {
                console.log('  [DRY RUN] Would queue "' + result.name + '" (' + resolvedCountry + ', ' + year + ', '
                    + episodeCount + ' eps, ' + status + ')');
                countryTally[resolvedCountry] = (countryTally[resolvedCountry] || 0) + 1;
                added++;
                existingTitles.add(result.name);
                await new Promise((resolve) => setTimeout(resolve, 300));
                continue;
            }

            const { error: insertError } = await supabase
                .from('series_candidates')
                .insert([{
                    title: result.name,
                    original_title: result.original_name || null,
                    country: resolvedCountry,
                    year: year,
                    episode_count: episodeCount,
                    status: status,
                    synopsis: result.overview || '',
                    poster_url: 'https://image.tmdb.org/t/p/w500' + result.poster_path,
                    tmdb_id: result.id,
                    source_keyword: SOURCE_KEYWORD,
                    review_status: 'pending',
                }]);

            if (insertError) {
                console.error('  Failed to queue "' + result.name + '": ' + insertError.message);
            } else {
                console.log('  Queued "' + result.name + '" (' + resolvedCountry + ', ' + year + ') for review');
                countryTally[resolvedCountry] = (countryTally[resolvedCountry] || 0) + 1;
                added++;
                existingTitles.add(result.name);
                existingTmdbIds.add(result.id);
            }

            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        page++;
    }

    console.log('\n=== Summary ===');
    console.log(added + ' new candidates ' + (DRY_RUN ? 'would be queued' : 'queued for review') + ' total:');
    for (const [country, count] of Object.entries(countryTally)) {
        console.log('  ' + country + ': ' + count);
    }

    console.log('\nDone.');
}

run();