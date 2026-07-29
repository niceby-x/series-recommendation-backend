//All database model types in one place

// NOTE: this interface is missing several columns that exist on the real
// `series` table (tmdb_id, media_type, is_animated, number_of_seasons,
// romance_pace, emotional_intensity, ending_type, content_level — see
// src/index.ts's /admin/candidates/:id/approve handler for the full insert
// shape). Only adding backdrop_url here for now since that's what's in
// scope; the rest were already out of sync before this change.
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