//All database model types in one place

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