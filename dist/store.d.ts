import { type NativeStore } from './addon.js';
import type { ConversationExchange } from './types.js';
export interface StoreHandle {
    native: NativeStore;
    /** Small typed key/value area: cursors and versions. Values are JSON. */
    meta: {
        get(key: string): unknown;
        putSync(key: string, value: unknown): void;
        remove(key: string): boolean;
    };
    close(): Promise<void>;
}
export declare function openStore(dbPath: string): StoreHandle;
/** Meta key holding the last transcript line synced for one archive file. Read
 * and advanced by the Rust store inside the insert transaction. */
export declare function syncCursorKey(archivePath: string): string;
/** Insert one exchange with no cursor bookkeeping. For tests and one-off use;
 * sync goes through insertExchangesForFile. */
export declare function insertExchange(store: StoreHandle, exchange: Omit<ConversationExchange, 'id'>, embedding: Float32Array | null): number;
export interface FileInsertResult {
    ids: number[];
    /** Rows another sync had already stored by the time this transaction ran. */
    skipped: number;
}
/** Insert a file's new exchanges under its cursor, transactionally. */
export declare function insertExchangesForFile(store: StoreHandle, archivePath: string, items: {
    exchange: Omit<ConversationExchange, 'id'>;
    embedding: Float32Array | null;
}[]): FileInsertResult;
export declare function nextId(store: StoreHandle): number;
export declare function getExchange(store: StoreHandle, id: number): ConversationExchange | undefined;
/** A vector written by a different embedding model has a different length.
 * Reading it as the current `dim` would produce garbage, so such rows are
 * treated as absent until ensureEmbeddingModel() rewrites them. */
export declare function getVector(store: StoreHandle, id: number, dim: number): Float32Array | undefined;
export declare function putVector(store: StoreHandle, id: number, embedding: Float32Array): void;
/** Every vector of the current dimension, packed for a graph rebuild
 * (design doc §07). Stale-model vectors are skipped, not misread. */
export declare function allVectors(store: StoreHandle, dim: number): {
    ids: number[];
    flat: Float32Array;
};
/** ids matching the given filters, answered from the secondary indexes. Returns
 * undefined when no filter was requested, so callers can tell "no filter" from
 * "filter matched nothing" (design doc §07). */
export declare function filterIds(store: StoreHandle, filters: {
    project?: string;
    sessionId?: string;
    after?: string;
    before?: string;
}): number[] | undefined;
/** Every exchange with an id at or above `fromId`, in id order (design doc §09). */
export declare function exchangesFrom(store: StoreHandle, fromId: number): ConversationExchange[];
/** Substring scan, newest first. The fallback when the BM25 addon is missing;
 * O(n) is fine at the thousands-to-tens-of-thousands scale this targets. */
export declare function textSearch(store: StoreHandle, query: string, opts: {
    after?: string;
    before?: string;
    project?: string;
    sessionId?: string;
    limit: number;
}): ConversationExchange[];
