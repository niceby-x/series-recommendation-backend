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
    // G3-01: set by PATCH /admin/series/:id whenever episode_count goes up
    // (see migrations/011_notifications_columns.sql). Null for any series
    // that has never had an episode-count increase since this column was
    // added -- not "unchanged," just "never bumped."
    episode_count_updated_at?: string | null;
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
    // S1-01: media_type already existed as a real column (populated by the
    // TMDB import scripts) but was never in this interface -- 'tv' rows are
    // "Series" and 'movie' rows are "Movies" on the admin Series & Movies
    // table's type tabs/column. Nullable because rows created before the
    // TMDB import existed never had it backfilled; those are treated as
    // 'tv' throughout (see admin/series.ts).
    media_type?: 'tv' | 'movie' | null;
    // S1-01: publish-workflow status, distinct from `status` above (which
    // is the show's own airing/completed/upcoming state). Gates visibility
    // on the public GET /series and GET /series/:id routes -- only
    // 'published' rows are publicly visible (see migrations/
    // 012_series_publish_status.sql).
    publish_status?: 'draft' | 'published' | 'archived';
    updated_at?: string;
    updated_by?: string | null;
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
    // G3-01: null means "never opened the notifications bell" -- see
    // migrations/011_notifications_columns.sql and GET /me/notifications.
    notifications_seen_at?: string | null;
}

export interface ApiResponse<T> {
    message: string;
    data?: T;
    count?: number;
}