// Storage layer -- design doc §05, now a thin face over the Rust store.
//
// LMDB itself lives in native/src/store.rs (design doc §03 "谁用什么语言"). This
// file owns only the translation between our TypeScript record shape and the
// native one, and keeps the function names the rest of the code already uses.
// The one semantic that matters lives in Rust: insertExchangesForFile() reads
// the per-file cursor, skips rows at or below it, inserts the rest and advances
// it inside ONE write transaction, which is what stops two concurrent syncs
// from storing the same exchange twice (design doc §17 item 3).
import { addon } from './addon.js';
export function openStore(dbPath) {
    const native = addon().StoreHandle.open(dbPath);
    return {
        native,
        meta: {
            get(key) {
                const raw = native.metaGet(key);
                return raw === null ? undefined : JSON.parse(raw);
            },
            putSync(key, value) {
                native.metaPut(key, JSON.stringify(value));
            },
            remove(key) {
                return native.metaRemove(key);
            },
        },
        close: async () => native.close(),
    };
}
/** Meta key holding the last transcript line synced for one archive file. Read
 * and advanced by the Rust store inside the insert transaction. */
export function syncCursorKey(archivePath) {
    return `synced_line_end:${archivePath}`;
}
function rowOf(exchange, embedding) {
    return {
        json: JSON.stringify(exchange),
        project: exchange.project,
        sessionId: exchange.sessionId,
        timestamp: exchange.timestamp,
        lineEnd: exchange.lineEnd,
        isSidechain: exchange.isSidechain === true,
        // Subagent turns never get a vector; the store enforces it too.
        embedding: embedding ?? undefined,
    };
}
/** Insert one exchange with no cursor bookkeeping. For tests and one-off use;
 * sync goes through insertExchangesForFile. */
export function insertExchange(store, exchange, embedding) {
    const { ids } = store.native.insert([rowOf(exchange, embedding)], null);
    return ids[0];
}
/** Insert a file's new exchanges under its cursor, transactionally. */
export function insertExchangesForFile(store, archivePath, items) {
    if (items.length === 0)
        return { ids: [], skipped: 0 };
    return store.native.insert(items.map(({ exchange, embedding }) => rowOf(exchange, embedding)), syncCursorKey(archivePath));
}
export function nextId(store) {
    return store.native.nextId();
}
export function getExchange(store, id) {
    const raw = store.native.get(id);
    return raw === null ? undefined : JSON.parse(raw);
}
/** A vector written by a different embedding model has a different length.
 * Reading it as the current `dim` would produce garbage, so such rows are
 * treated as absent until ensureEmbeddingModel() rewrites them. */
export function getVector(store, id, dim) {
    const v = store.native.getVector(id);
    return v !== null && v.length === dim ? v : undefined;
}
export function putVector(store, id, embedding) {
    store.native.putVector(id, embedding);
}
/** Every vector of the current dimension, packed for a graph rebuild
 * (design doc §07). Stale-model vectors are skipped, not misread. */
export function allVectors(store, dim) {
    const { ids, data } = store.native.allVectors(dim);
    return { ids: Array.from(ids), flat: data };
}
/** ids matching the given filters, answered from the secondary indexes. Returns
 * undefined when no filter was requested, so callers can tell "no filter" from
 * "filter matched nothing" (design doc §07). */
export function filterIds(store, filters) {
    const ids = store.native.filterIds(filters);
    return ids === null ? undefined : Array.from(ids);
}
/** Every exchange with an id at or above `fromId`, in id order (design doc §09). */
export function exchangesFrom(store, fromId) {
    return store.native.exchangesFrom(fromId).map((raw) => JSON.parse(raw));
}
/** Substring scan, newest first. The fallback when the BM25 addon is missing;
 * O(n) is fine at the thousands-to-tens-of-thousands scale this targets. */
export function textSearch(store, query, opts) {
    const q = query.toLowerCase();
    const results = [];
    const all = exchangesFrom(store, 0);
    for (let i = all.length - 1; i >= 0; i--) {
        const exchange = all[i];
        if (exchange.isSidechain)
            continue;
        if (opts.after && exchange.timestamp < opts.after)
            continue;
        if (opts.before && exchange.timestamp > opts.before)
            continue;
        if (opts.project && exchange.project !== opts.project)
            continue;
        if (opts.sessionId && exchange.sessionId !== opts.sessionId)
            continue;
        if (exchange.userMessage.toLowerCase().includes(q) || exchange.assistantMessage.toLowerCase().includes(q)) {
            results.push(exchange);
            if (results.length >= opts.limit)
                break;
        }
    }
    return results;
}
