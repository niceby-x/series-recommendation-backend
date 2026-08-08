// src/services/supabase.ts
//
// The one place SUPABASE_URL/SUPABASE_KEY get read and turned into a
// client. Previously every script (and index.ts itself) each called
// createClient() with the same two env vars independently -- eight
// separate copies of identical connection setup. Now everything imports
// this single client instead.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);
