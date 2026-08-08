import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN as string;
const ANIMATION_GENRE_ID = 16;

const TMDB_HEADERS = {
    Authorization: 'Bearer ' + TMDB_TOKEN,
    accept: 'application/json',
};

async function run() {
    // Only pending candidates matter here — approved/rejected ones are already decided.
    const { data: candidates, error } = await supabase
        .from('series_candidates')
        .select('id, tmdb_id, title, media_type, number_of_seasons')
        .eq('review_status', 'pending')
        .is('number_of_seasons', null);

    if (error) {
        console.error('Could not load candidates: ' + error.message);
        return;
    }

    console.log('Enriching ' + candidates.length + ' pending candidates missing season/animation data...\n');

    let updated = 0;

    for (const candidate of candidates) {
        if (candidate.tmdb_id < 0) {
            // Negative ids are manual-backfill placeholders with no real TMDB entry — skip.
            console.log('  Skipping "' + candidate.title + '" (no real tmdb_id)');
            continue;
        }

        // Was always hardcoded to /tv/ regardless of the candidate's actual
        // media_type -- movies were being looked up as TV shows and TMDB
        // correctly 404'd nearly all of them. media_type is 'tv' or 'movie'
        // (see discover-series-by-keyword.ts), matching the same
        // tv-vs-movie endpoint split that script already uses.
        const endpoint = candidate.media_type === 'movie' ? 'movie' : 'tv';
        const res = await fetch('https://api.themoviedb.org/3/' + endpoint + '/' + candidate.tmdb_id, { headers: TMDB_HEADERS });

        if (!res.ok) {
            console.error('  Failed to fetch details for "' + candidate.title + '": ' + res.status);
            continue;
        }

        const json = await res.json();
        const isAnimated = (json.genres || []).some((g: { id: number }) => g.id === ANIMATION_GENRE_ID);
        // Movies don't have seasons -- 0 rather than null so the
        // `.is('number_of_seasons', null)` filter above doesn't keep
        // re-selecting the same already-enriched movies on every future run.
        const numberOfSeasons = endpoint === 'movie' ? 0 : json.number_of_seasons ?? null;

        const { error: updateError } = await supabase
            .from('series_candidates')
            .update({ is_animated: isAnimated, number_of_seasons: numberOfSeasons })
            .eq('id', candidate.id);

        if (updateError) {
            console.error('  Failed to update "' + candidate.title + '": ' + updateError.message);
        } else {
            console.log('  Updated "' + candidate.title + '" (' + numberOfSeasons + ' seasons' + (isAnimated ? ', ANIMATED' : '') + ')');
            updated++;
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('\nDone. ' + updated + ' candidates enriched.');
}

run();