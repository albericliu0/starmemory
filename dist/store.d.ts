import { type RootDatabase, type Database } from 'lmdb';
import type { ConversationExchange } from './types.js';
export interface StoreHandle {
    root: RootDatabase;
    exchanges: Database<string, number>;
    vectors: Database<Buffer, number>;
    idxProject: Database<null, [string, number]>;
    idxSession: Database<null, [string, number]>;
    idxTime: Database<null, [string, number]>;
    meta: Database<unknown, string>;
    close(): Promise<void>;
}
export declare function openStore(dbPath: string): StoreHandle;
/** Next id = current max id in `exchanges` + 1 (0 for an empty store). Used
 * both as the primary key and, per design doc §12, as the sync cursor. */
export declare function nextId(store: StoreHandle): number;
export declare function insertExchange(store: StoreHandle, exchange: Omit<ConversationExchange, 'id'>, embedding: Float32Array | null): number;
export declare function getExchange(store: StoreHandle, id: number): ConversationExchange | undefined;
export declare function getVector(store: StoreHandle, id: number, dim: number): Float32Array | undefined;
/** All (id, vector) pairs in the store, for a full index rebuild (design doc §07). */
export declare function allVectors(store: StoreHandle, dim: number): Generator<{
    id: number;
    vector: Float32Array;
}>;
/** ids whose exchange matches the given filters (design doc §07's "元数据过滤"
 * -> ArrayIdFilter path). Every clause is answered from a secondary index, so
 * this stays cheap enough to run before the graph traversal rather than after it.
 *
 * Returns undefined when no filter was requested, so callers can tell "no filter"
 * apart from "filter matched nothing". */
export declare function filterIds(store: StoreHandle, filters: {
    project?: string;
    sessionId?: string;
    after?: string;
    before?: string;
}): number[] | undefined;
/** Every exchange with an id at or above `fromId`, in id order. This is how the
 * text index catches up from its cursor (design doc §09). */
export declare function exchangesFrom(store: StoreHandle, fromId: number): ConversationExchange[];
/** Substring search over exchange text, with optional date/project/session filters
 * applied post-hoc (design doc §07: "text 检索... 照抄, 对 exchanges sub-DB 做 cursor
 * 遍历做子串匹配"). O(n) full scan -- fine at the thousands-to-tens-of-thousands scale
 * this engine targets (see design doc §04). */
export declare function textSearch(store: StoreHandle, query: string, opts: {
    after?: string;
    before?: string;
    project?: string;
    sessionId?: string;
    limit: number;
}): ConversationExchange[];
