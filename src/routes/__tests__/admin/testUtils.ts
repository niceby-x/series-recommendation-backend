// src/routes/__tests__/admin/testUtils.ts
//
// A3-01: shared helpers for the admin/*.test.ts files.
//
// mockSupabase() builds a fake `supabase` client whose `.from(table)`
// returns a query-builder stand-in: every chain method (select, eq, in,
// order, update, delete, insert, ...) returns itself, and the object is
// "thenable" -- awaiting it at any point resolves to whatever result was
// queued for that table, matching how the real supabase-js query builder
// works (routes sometimes build up a query across several `if` branches
// before awaiting it once, without calling a single obvious terminal
// method). Results are queued per table name, FIFO -- call
// `queue('genres', { data: [...], error: null })` once for each time the
// route under test is expected to call `.from('genres')`, in order.
//
// This is deliberately generic rather than one hand-built mock per route,
// since the admin routers make long sequential chains of `.from()` calls
// (see e.g. the restore/reject cleanupTables loops) that would otherwise
// mean re-deriving the exact chain shape in every test file.

import { vi } from 'vitest';

export type QueuedResult = { data?: any; error?: any; count?: number | null };

const CHAIN_METHODS = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'in', 'order', 'limit', 'range',
    'maybeSingle', 'single',
] as const;

export function mockSupabase() {
    const queues = new Map<string, QueuedResult[]>();
    const calls: { table: string }[] = [];

    function queue(table: string, result: QueuedResult) {
        if (!queues.has(table)) queues.set(table, []);
        queues.get(table)!.push(result);
    }

    function buildQueryResult(table: string): QueuedResult {
        const q = queues.get(table);
        if (!q || q.length === 0) {
            throw new Error(
                'mockSupabase: no queued result for .from("' + table + '") -- ' +
                'call queue("' + table + '", { data, error }) once per expected call, in order.'
            );
        }
        return q.shift()!;
    }

    function makeBuilder(table: string) {
        const builder: any = {};
        for (const method of CHAIN_METHODS) {
            builder[method] = vi.fn(() => builder);
        }
        // Thenable: awaiting the builder at ANY point in the chain resolves
        // to the table's next queued result, same as a real supabase-js
        // query builder (which is a thenable itself, not just after a
        // terminal call like .single()).
        builder.then = (resolve: any, reject: any) => {
            let result: QueuedResult;
            try {
                result = buildQueryResult(table);
            } catch (e) {
                return Promise.reject(e).then(resolve, reject);
            }
            return Promise.resolve(result).then(resolve, reject);
        };
        builder.catch = (reject: any) => Promise.resolve(buildQueryResult(table)).catch(reject);
        return builder;
    }

    const from = vi.fn((table: string) => {
        calls.push({ table });
        return makeBuilder(table);
    });

    return { supabase: { from, auth: { admin: { deleteUser: vi.fn() } } }, queue, calls };
}

// requireAdmin is mocked per test file (its real implementation does its
// own auth/db work, out of scope for these route-logic tests) -- this
// factory keeps the two shapes tests need consistent: an admin allowed
// through (optionally attaching adminActor, since A2-02's audit logging
// reads req.adminActor), or rejected with the same status codes the real
// implementation uses.
export function allowAdmin(adminActor: { id: number | null; email: string | null } = { id: 1, email: 'admin@example.com' }) {
    return vi.fn(async (req: any) => {
        req.adminActor = adminActor;
        return true;
    });
}

export function rejectAdmin(status: 401 | 403 = 403, message = 'Admin access required.') {
    return vi.fn(async (_req: any, res: any) => {
        res.status(status).json({ message });
        return false;
    });
}
