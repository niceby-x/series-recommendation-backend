// src/scripts/compute-rank-snapshot.ts
//
// H2-01 follow-up: POST /admin/rank-snapshots/run works, but it's gated
// by requireAdmin -- a live Supabase Auth session token, not something
// an unattended scheduler has. That's fine for "admin clicks a button to
// force a re-run," but it means nothing was actually producing daily
// snapshots automatically, so rank_trend would sit at 'new'/null
// forever in practice.
//
// Rather than build a second auth path onto the admin route for
// machine callers, this follows the same pattern already used for every
// other scheduled maintenance task in this repo (see
// enrich-pending-candidates.ts, fetch-posters.ts): a script that talks
// to Supabase directly with the service-role key, run by
// .github/workflows/pipeline.yml's nightly schedule. No new secret or
// auth mechanism needed -- SUPABASE_URL/SUPABASE_KEY are already wired
// into that workflow.
//
// This is a thin wrapper: all the actual ranking/scoring logic lives in
// computeAndStoreSnapshot() (services/rankSnapshots.ts) and is unit
// tested there. This script just calls it and logs the result in the
// same "console.log a summary" style the other pipeline scripts use.

import { computeAndStoreSnapshot } from '../services/rankSnapshots';

async function run() {
    console.log('Computing today\'s series rank snapshot...\n');

    try {
        const { snapshotDate, count } = await computeAndStoreSnapshot();
        console.log('Done. Ranked ' + count + ' rated series for ' + snapshotDate + '.');
    } catch (err) {
        console.error('Rank snapshot failed: ' + (err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
    }
}

run();
