import { supabase } from '../services/supabase';

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
    if (DRY_RUN) {
        console.log('Running in DRY RUN mode — nothing will be written to Supabase.\n');
    }

    const { data: allSeries, error: seriesError } = await supabase
        .from('series')
        .select('*');

    if (seriesError) {
        console.error('Could not load series: ' + seriesError.message);
        return;
    }

    const { data: existingCandidates, error: candidatesError } = await supabase
        .from('series_candidates')
        .select('title');

    if (candidatesError) {
        console.error('Could not load existing candidates: ' + candidatesError.message);
        return;
    }

    const alreadyTracked = new Set(existingCandidates.map((c) => c.title));

    const untracked = allSeries.filter((s) => !alreadyTracked.has(s.title));

    console.log('Found ' + allSeries.length + ' total series, ' + untracked.length + ' with no matching candidate record.\n');

    let backfilled = 0;

    for (const series of untracked) {
        // Negative placeholder id, guaranteed unique per series row and guaranteed
        // to never collide with a real (always-positive) TMDB id.
        const placeholderTmdbId = -series.id;

        if (DRY_RUN) {
            console.log('  [DRY RUN] Would backfill "' + series.title + '" as approved (placeholder tmdb_id ' + placeholderTmdbId + ')');
            backfilled++;
            continue;
        }

        const { error: insertError } = await supabase
            .from('series_candidates')
            .insert([{
                tmdb_id: placeholderTmdbId,
                title: series.title,
                original_title: series.original_title || null,
                synopsis: series.synopsis || '',
                country: series.country,
                year: series.year,
                episode_count: series.episode_count,
                status: series.status,
                poster_url: series.poster_url,
                backdrop_url: series.backdrop_url,
                source_keyword: 'manual-backfill',
                review_status: 'approved',
            }]);

        if (insertError) {
            console.error('  Failed to backfill "' + series.title + '": ' + insertError.message);
        } else {
            console.log('  Backfilled "' + series.title + '"');
            backfilled++;
        }
    }

    console.log('\nDone. ' + backfilled + ' series ' + (DRY_RUN ? 'would be' : 'were') + ' backfilled as approved.');
}

run();