// src/scripts/backfill-release-date.ts
//
// One-time backfill for the new `release_date` column (migrations/
// 010_series_release_date.sql). Only touches rows where release_date IS
// NULL, so it's safe to re-run -- already-filled rows are skipped.
//
// G1-01: this ports lib/newReleasesContent.ts's mockDaysAgoFor(id) exactly
// (same seeded formula) so existing rows land on the *same* date they
// already appeared to have on the New Releases page -- this is a one-time
// conversion of "fake date, recomputed from scratch on every page load"
// into "real, stored date," not a reset. Once this has run and the
// frontend switches to reading release_date from GET /series instead of
// calling mockDaysAgoFor itself, that function (and this script) have no
// further purpose -- new series going forward should get a real
// release_date at creation time instead.
//
// Usage:
//   npx tsx src/scripts/backfill-release-date.ts            (writes to Supabase)
//   npx tsx src/scripts/backfill-release-date.ts --dry-run   (prints what it would do)

import { supabase } from '../services/supabase';

const DRY_RUN = process.argv.includes('--dry-run');

interface SeriesRow {
    id: number;
    title: string;
    release_date: string | null;
}

// Exact port of lib/newReleasesContent.ts's seededFraction/mockDaysAgoFor
// on the frontend -- must stay byte-for-byte identical, or existing rows
// would land on a different date than the one they already showed.
function seededFraction(seed: number): number {
    const x = Math.sin(seed * 91387 + 7) * 10000;
    return x - Math.floor(x);
}

function mockDaysAgoFor(id: number): number {
    return Math.floor(seededFraction(id) * 60);
}

function toDateString(daysAgo: number): string {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD, what a Postgres `date` column expects
}

async function main() {
    console.log(DRY_RUN ? 'Running in --dry-run mode (no writes)' : 'Running for real (will write to Supabase)');

    const { data, error } = await supabase
        .from('series')
        .select('id, title, release_date')
        .is('release_date', null);

    if (error) {
        console.error('Failed to fetch series:', error.message);
        process.exit(1);
    }

    const rows = (data || []) as SeriesRow[];
    console.log(`Found ${rows.length} series with no release_date yet.`);

    let updated = 0;
    let failed = 0;

    for (const row of rows) {
        const releaseDate = toDateString(mockDaysAgoFor(row.id));
        console.log(`  #${row.id} "${row.title}" -> ${releaseDate}`);

        if (DRY_RUN) continue;

        const { error: updateError } = await supabase
            .from('series')
            .update({ release_date: releaseDate })
            .eq('id', row.id);

        if (updateError) {
            console.error(`  Failed to update #${row.id}:`, updateError.message);
            failed++;
        } else {
            updated++;
        }
    }

    console.log(DRY_RUN ? `Would update ${rows.length} rows.` : `Updated ${updated} rows (${failed} failed).`);
}

main();
