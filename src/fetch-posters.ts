import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN as string;

interface Series {
    id: number;
    title: string;
    year: number;
}

interface TMDBImageUrls {
    posterUrl: string | null;
    backdropUrl: string | null;
}

async function searchTMDBImages(title: string, year: number): Promise<TMDBImageUrls> {
    const url = `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(title)}&first_air_date_year=${year}`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${TMDB_TOKEN}`,
            accept: 'application/json',
        },
    });

    if (!res.ok) {
        console.error(`  TMDB request failed for "${title}": ${res.status}`);
        return { posterUrl: null, backdropUrl: null };
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        console.log(`  No TMDB results found for "${title}" (${year})`);
        return { posterUrl: null, backdropUrl: null };
    }

    const bestMatch = json.results[0];

    if (!bestMatch.poster_path) {
        console.log(`  Match found for "${title}" but it has no poster image`);
    }

    // TMDB image paths are relative — this builds the full image URL at a good display size
    return {
        posterUrl: bestMatch.poster_path ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}` : null,
        backdropUrl: bestMatch.backdrop_path ? `https://image.tmdb.org/t/p/w1280${bestMatch.backdrop_path}` : null,
    };
}

async function run() {
    const { data: seriesList, error } = await supabase
        .from('series')
        .select('id, title, year');

    if (error) {
        console.error('Failed to fetch series from Supabase:', error.message);
        return;
    }

    console.log(`Found ${seriesList.length} series. Fetching posters from TMDB...\n`);

    for (const series of seriesList as Series[]) {
        console.log(`Searching: "${series.title}" (${series.year})`);

        const { posterUrl, backdropUrl } = await searchTMDBImages(series.title, series.year);

        if (!posterUrl && !backdropUrl) {
            console.log(`  Skipped — no images saved for "${series.title}"\n`);
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
            console.error(`  Failed to save images for "${series.title}": ${updateError.message}\n`);
        } else {
            console.log(`  Saved poster: ${posterUrl ?? '(none)'} | backdrop: ${backdropUrl ?? '(none)'}\n`);
        }

        // Small delay to stay well within TMDB's rate limits
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('Done.');
}

run();