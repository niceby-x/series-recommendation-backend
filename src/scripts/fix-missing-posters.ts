import { supabase } from '../services/supabase';
import { TMDB_HEADERS } from '../services/tmdb';

interface TMDBImageUrls {
    posterUrl: string | null;
    backdropUrl: string | null;
}

async function searchTMDBImagesNoYear(title: string): Promise<TMDBImageUrls> {
    const url = 'https://api.themoviedb.org/3/search/tv?query=' + encodeURIComponent(title);

    const res = await fetch(url, {
        headers: TMDB_HEADERS,
    });

    if (!res.ok) {
        console.error('  TMDB request failed: ' + res.status);
        return { posterUrl: null, backdropUrl: null };
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        console.log('  Still no results found');
        return { posterUrl: null, backdropUrl: null };
    }

    const bestMatch = json.results[0];

    if (!bestMatch.poster_path) {
        console.log('  Found a match but it has no poster image');
    }

    return {
        posterUrl: bestMatch.poster_path ? 'https://image.tmdb.org/t/p/w500' + bestMatch.poster_path : null,
        backdropUrl: bestMatch.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + bestMatch.backdrop_path : null,
    };
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

        const { posterUrl, backdropUrl } = await searchTMDBImagesNoYear(series.title);

        if (!posterUrl && !backdropUrl) {
            console.log('  Still no images for "' + series.title + '"\n');
            continue;
        }

        const updatePayload: Record<string, string> = {};
        if (posterUrl) updatePayload.poster_url = posterUrl;
        if (backdropUrl) updatePayload.backdrop_url = backdropUrl;

        const { error: updateError } = await supabase
            .from('series')
            .update(updatePayload)
            .eq('id', series.id);

        if (updateError) {
            console.error('  Failed to save images: ' + updateError.message + '\n');
        } else {
            console.log('  Saved poster: ' + (posterUrl ?? '(none)') + ' | backdrop: ' + (backdropUrl ?? '(none)') + '\n');
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('Done.');
}

run();