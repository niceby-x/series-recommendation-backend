//All database model types in one place

// NOTE: this interface is missing several columns that exist on the real
// `series` table (tmdb_id, media_type, is_animated, number_of_seasons,
// romance_pace, emotional_intensity, ending_type, content_level — see
// src/index.ts's /admin/candidates/:id/approve handler for the full insert
// shape). Only adding backdrop_url here for now since that's what's in
// scope; the rest were already out of sync before this change.
export interface SeriesTag {
    id: number;
    dimension: "mood" | "trope" | "relationship_dynamic" | "theme" | "content_warning";
    value_key: string;
    display_label: string;
    display_emoji: string | null;
}

export interface Series {
    id: number;
    title: string;
    original_title: string | null;
    synopsis: string | null;
    country: string;
    year: number;
    episode_count: number;
    status: "airing" | "completed" | "upcoming";
    poster_url: string | null;
    backdrop_url: string | null;
    created_at: string;
    // G1-01: real release date, backfilled from the old client-side mock
    // hash (see migrations/010_series_release_date.sql) and populated for
    // real on new series going forward. Nullable for any row that
    // predates the column and hasn't been backfilled yet.
    release_date?: string | null;
    // Join results, not real columns -- present on GET /series and
    // GET /series/:id responses (see the series_tags join in src/index.ts),
    // not on a raw row from `series` itself.
    tags?: SeriesTag[];
    tag_ids?: number[];
    // H2-01: real week-over-week popularity rank, present on GET /series
    // when the rank-snapshot job (POST /admin/rank-snapshots/run) has
    // run for this series. null if the job hasn't been run yet, or the
    // series has no ratings to rank -- not "unchanged."
    rank?: number | null;
    rank_trend?: 'up' | 'down' | 'flat' | 'new' | null;
}

export interface Rating {
    id: number;
    user_id: number;
    series_id: number;
    score: number;
    review_text: string | null;
    created_at: string;
}

export interface User {
    id: number;
    username: string;
    email: string;
    password_hash?: string;
    created_at: string;
}

export interface ApiResponse<T> {
    message: string;
    data?: T;
    count?: number;
}