import { supabase } from '../services/supabase';
import { TMDB_HEADERS } from '../services/tmdb';

interface NewSeries {
    title: string;
    country: string;
    year: number;
    episode_count: number;
    status: string;
    synopsis: string;
}

const seriesToAdd: NewSeries[] = [
    { title: 'KinnPorsche', country: 'Thailand', year: 2022, episode_count: 14, status: 'completed',
      synopsis: 'A university student becomes the personal bodyguard for the son of a powerful mafia family and finds himself drawn into a world of danger and desire.' },
    { title: 'Bad Buddy', country: 'Thailand', year: 2021, episode_count: 12, status: 'completed',
      synopsis: 'Two childhood rivals from feuding families fall for each other despite years of being told to stay apart.' },
    { title: 'Vice Versa', country: 'Thailand', year: 2023, episode_count: 12, status: 'completed',
      synopsis: 'Two students swap bodies during a solar eclipse and must navigate each other\'s lives, and feelings, until they can switch back.' },
    { title: 'Not Me', country: 'Thailand', year: 2021, episode_count: 15, status: 'completed',
      synopsis: 'A young man infiltrates a group of activists to uncover the truth behind his twin brother\'s mysterious accident.' },
    { title: 'Only Friends', country: 'Thailand', year: 2023, episode_count: 12, status: 'completed',
      synopsis: 'A tangled group of friends and lovers navigate jealousy, betrayal, and hookups on a Thai island getaway.' },
    { title: 'My Engineer', country: 'Thailand', year: 2019, episode_count: 12, status: 'completed',
      synopsis: 'A group of engineering students juggle friendship, rivalry, and unexpected romance on campus.' },
    { title: 'Theory of Love', country: 'Thailand', year: 2019, episode_count: 12, status: 'completed',
      synopsis: 'A film student pines for his best friend while trying to move on with someone new.' },
    { title: 'Lovely Writer', country: 'Thailand', year: 2021, episode_count: 12, status: 'completed',
      synopsis: 'A struggling actor becomes the muse, and the target, of a novelist writing a story clearly based on their own history together.' },
    { title: 'A Tale of Thousand Stars', country: 'Thailand', year: 2021, episode_count: 10, status: 'completed',
      synopsis: 'A disillusioned young doctor sent to a rural village crosses paths with a quiet man hiding a painful past.' },
    { title: 'Semantic Error', country: 'Korea', year: 2022, episode_count: 8, status: 'completed',
      synopsis: 'A rule-following computer science student clashes with a free-spirited art major after a group project goes wrong.' },
    { title: 'To My Star', country: 'Korea', year: 2021, episode_count: 8, status: 'completed',
      synopsis: 'A former actor and a gruff restaurant owner grow close after an unexpected drunken encounter.' },
    { title: 'Old Fashion Cupcake', country: 'Japan', year: 2022, episode_count: 8, status: 'completed',
      synopsis: 'An overworked manager reconnects with his former junior colleague, who has never stopped being in love with him.' },
    { title: 'Ossan\'s Love', country: 'Japan', year: 2018, episode_count: 8, status: 'completed',
      synopsis: 'A reluctant office worker finds himself pursued by both his male boss and a coworker.' },
    { title: 'Given', country: 'Japan', year: 2019, episode_count: 11, status: 'completed',
      synopsis: 'A high schooler\'s chance encounter with a broken guitar leads him into a band, and a fragile new relationship.' },
    { title: 'HIStory3: Trapped', country: 'Taiwan', year: 2019, episode_count: 8, status: 'completed',
      synopsis: 'Two adversaries turned allies must work together to survive after being trapped in a collapsed mine.' },
    { title: 'HIStory2: Crossing the Line', country: 'Taiwan', year: 2018, episode_count: 10, status: 'completed',
      synopsis: 'A closeted delivery driver and the man who catches him stealing form an unlikely bond.' },
    { title: 'Word of Honor', country: 'China', year: 2021, episode_count: 36, status: 'completed',
      synopsis: 'Two skilled wanderers from opposing worlds join forces and grow close while chasing a legendary manual.' },
];

interface TMDBImageUrls {
    posterUrl: string | null;
    backdropUrl: string | null;
}

async function searchTMDBImages(title: string, year: number): Promise<TMDBImageUrls> {
    const url = 'https://api.themoviedb.org/3/search/tv?query=' + encodeURIComponent(title) + '&first_air_date_year=' + year;

    const res = await fetch(url, {
        headers: TMDB_HEADERS,
    });

    if (!res.ok) {
        console.error('  TMDB request failed for "' + title + '": ' + res.status);
        return { posterUrl: null, backdropUrl: null };
    }

    const json = await res.json();

    if (!json.results || json.results.length === 0) {
        console.log('  No TMDB results found for "' + title + '" (' + year + ')');
        return { posterUrl: null, backdropUrl: null };
    }

    const bestMatch = json.results[0];

    if (!bestMatch.poster_path) {
        console.log('  Match found for "' + title + '" but it has no poster image');
    }

    return {
        posterUrl: bestMatch.poster_path ? 'https://image.tmdb.org/t/p/w500' + bestMatch.poster_path : null,
        backdropUrl: bestMatch.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + bestMatch.backdrop_path : null,
    };
}

async function run() {
    console.log('Adding ' + seriesToAdd.length + ' series...\n');

    for (const series of seriesToAdd) {
        console.log('Checking: "' + series.title + '"');

        const { data: existing } = await supabase
            .from('series')
            .select('id')
            .eq('title', series.title)
            .maybeSingle();

        if (existing) {
            console.log('  Already exists, skipping.\n');
            continue;
        }

        const { posterUrl, backdropUrl } = await searchTMDBImages(series.title, series.year);

        const { error: insertError } = await supabase
            .from('series')
            .insert([{
                title: series.title,
                country: series.country,
                year: series.year,
                episode_count: series.episode_count,
                status: series.status,
                synopsis: series.synopsis,
                poster_url: posterUrl,
                backdrop_url: backdropUrl,
            }]);

        if (insertError) {
            console.error('  Failed to insert "' + series.title + '": ' + insertError.message + '\n');
        } else {
            console.log('  Added with poster: ' + (posterUrl ? 'yes' : 'no poster found')
                + ', backdrop: ' + (backdropUrl ? 'yes' : 'no backdrop found') + '\n');
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('Done.');
}

run();