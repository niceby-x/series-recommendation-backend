// src/services/tmdb.ts
//
// TMDB auth setup, extracted the same way as services/supabase.ts --
// several scripts each rebuilt an identical { Authorization: 'Bearer ' +
// TMDB_TOKEN, accept: 'application/json' } headers object. This is just
// the auth/connection piece, not a full API client -- each script still
// builds its own request URLs and does its own response parsing, since
// those genuinely differ per script (search vs details, tv vs movie,
// what fields it needs back).

import 'dotenv/config';

const TMDB_TOKEN = process.env.TMDB_ACCESS_TOKEN as string;

export const TMDB_HEADERS = {
    Authorization: 'Bearer ' + TMDB_TOKEN,
    accept: 'application/json',
};

export const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
