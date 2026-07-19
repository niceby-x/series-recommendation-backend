import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN as string;

async function searchTMDBPosterNoYear(title: string): Promise<string | null> {
    const url = 'https://api.themoviedb.org/3/search/tv?query=' + encodeURIComponent(title);

    const res = await fetch(url, {
        headers: {
            Authorization: 'Bearer ' + TMDB_TOKEN,
            accept: 'application/json',
        },
    });

    if (!res.ok) {
        console.error('  TMDB request failed: ' + res.status);
        return null;
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        console.log('  Still no results found');
        return null;
    }

    const bestMatch = json.results[0];

    if (!bestMatch.poster_path) {
        console.log('  Found a match but it has no poster image');
        return null;
    }

    return 'https://image.tmdb.org/t/p/w500' + bestMatch.poster_path;
}

async function run() {
    const { data: missing, error } = await supabase
        .from('series')
        .select('id, title')
        .is('poster_url', null);

    if (error) {
        console.error('Failed to fetch series:', error.message);
        return;
    }

    console.log('Found ' + missing.length + ' series missing a poster.\n');

    for (const series of missing) {
        console.log('Retrying: "' + series.title + '" (no year filter)');

        const posterUrl = await searchTMDBPosterNoYear(series.title);

        if (!posterUrl) {
            console.log('  Still no poster for "' + series.title + '"\n');
            continue;
        }

        const { error: updateError } = await supabase
            .from('series')
            .update({ poster_url: posterUrl })
            .eq('id', series.id);

        if (updateError) {
            console.error('  Failed to save poster: ' + updateError.message + '\n');
        } else {
            console.log('  Saved poster: ' + posterUrl + '\n');
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('Done.');
}

run();