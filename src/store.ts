// Storage layer -- design doc §05, now a thin face over the Rust store.
//
// LMDB itself lives in native/src/store.rs (design doc §03 "谁用什么语言"). This
// file owns only the translation between our TypeScript record shape and the
// native one, and keeps the function names the rest of the code already uses.
// The one semantic that matters lives in Rust: insertExchangesForFile() reads
// the per-file cursor, skips rows at or below it, inserts the rest and advances
// it inside ONE write transaction, which is what stops two concurrent syncs
// from storing the same exchange twice (design doc §16 item 3).
import { addon, type NativeStore, type NativeStoreRow } from './addon.js';
import type { ConversationExchange, Harness } from './types.js';

/** What an exchange with no harness tag means: it was written when Claude Code
 * was the only harness there was (design doc §16). */
export const DEFAULT_HARNESS: Harness = 'claude';

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

export function openStore(dbPath: string): StoreHandle {
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
export function syncCursorKey(archivePath: string): string {
  return `synced_line_end:${archivePath}`;
}

function rowOf(exchange: Omit<ConversationExchange, 'id'>, embedding: Float32Array | null): NativeStoreRow {
  return {
    json: JSON.stringify(exchange),
    project: exchange.project,
    sessionId: exchange.sessionId,
    timestamp: exchange.timestamp,
    lineEnd: exchange.lineEnd,
    isSidechain: exchange.isSidechain === true,
    // Subagent turns never get a vector; the store enforces it too.
    embedding: embedding ?? undefined,
    harness: exchange.harness ?? DEFAULT_HARNESS,
  };
}

/** Insert one exchange with no cursor bookkeeping. For tests and one-off use;
 * sync goes through insertExchangesForFile. */
export function insertExchange(
  store: StoreHandle,
  exchange: Omit<ConversationExchange, 'id'>,
  embedding: Float32Array | null
): number {
  const { ids } = store.native.insert([rowOf(exchange, embedding)], null);
  return ids[0];
}

export interface FileInsertResult {
  ids: number[];
  /** Rows another sync had already stored by the time this transaction ran. */
  skipped: number;
}

/** Insert a file's new exchanges under its cursor, transactionally. */
export function insertExchangesForFile(
  store: StoreHandle,
  archivePath: string,
  items: { exchange: Omit<ConversationExchange, 'id'>; embedding: Float32Array | null }[]
): FileInsertResult {
  if (items.length === 0) return { ids: [], skipped: 0 };
  return store.native.insert(
    items.map(({ exchange, embedding }) => rowOf(exchange, embedding)),
    syncCursorKey(archivePath)
  );
}

/** Remove exchanges for good (design doc archive-and-summaries §13). The
 * vector index is a cache rebuilt by the caller; the text index has its own
 * deleteExchanges. Returns how many rows existed. */
export function deleteExchanges(store: StoreHandle, ids: number[]): number {
  if (ids.length === 0) return 0;
  return store.native.delete(Float64Array.from(ids));
}

export function nextId(store: StoreHandle): number {
  return store.native.nextId();
}

export function getExchange(store: StoreHandle, id: number): ConversationExchange | undefined {
  const raw = store.native.get(id);
  return raw === null ? undefined : (JSON.parse(raw) as ConversationExchange);
}

/** A vector written by a different embedding model has a different length.
 * Reading it as the current `dim` would produce garbage, so such rows are
 * treated as absent until ensureEmbeddingModel() rewrites them. */
export function getVector(store: StoreHandle, id: number, dim: number): Float32Array | undefined {
  const v = store.native.getVector(id);
  return v !== null && v.length === dim ? v : undefined;
}

export function putVector(store: StoreHandle, id: number, embedding: Float32Array): void {
  store.native.putVector(id, embedding);
}

/** Every vector of the current dimension, packed for a graph rebuild
 * (design doc §07). Stale-model vectors are skipped, not misread. */
export function allVectors(store: StoreHandle, dim: number): { ids: number[]; flat: Float32Array } {
  const { ids, data } = store.native.allVectors(dim);
  return { ids: Array.from(ids), flat: data };
}

/** ids matching the given filters, answered from the secondary indexes. Returns
 * undefined when no filter was requested, so callers can tell "no filter" from
 * "filter matched nothing" (design doc §07). */
export function filterIds(
  store: StoreHandle,
  filters: { project?: string; sessionId?: string; harness?: Harness; after?: string; before?: string }
): number[] | undefined {
  const ids = store.native.filterIds(filters);
  return ids === null ? undefined : Array.from(ids);
}

/** Meta key recording that idx_harness has been backfilled once. */
export const HARNESS_INDEX_KEY = 'harness_index_version';

/** Give rows stored before Codex support a harness index entry, so a harness
 * filter does not silently drop them. Returns the number of rows walked. */
export function reindexHarness(store: StoreHandle): number {
  return store.native.reindexHarness();
}

/** Every exchange with an id at or above `fromId`, in id order (design doc §09). */
export function exchangesFrom(store: StoreHandle, fromId: number): ConversationExchange[] {
  return store.native.exchangesFrom(fromId).map((raw) => JSON.parse(raw) as ConversationExchange);
}

/** Substring scan, newest first. The fallback when the BM25 addon is missing;
 * O(n) is fine at the thousands-to-tens-of-thousands scale this targets. */
export function textSearch(
  store: StoreHandle,
  query: string,
  opts: { after?: string; before?: string; project?: string; sessionId?: string; harness?: Harness; limit: number }
): ConversationExchange[] {
  const q = query.toLowerCase();
  const results: ConversationExchange[] = [];
  const all = exchangesFrom(store, 0);
  for (let i = all.length - 1; i >= 0; i--) {
    const exchange = all[i];
    if (exchange.isSidechain) continue;
    if (opts.after && exchange.timestamp < opts.after) continue;
    if (opts.before && exchange.timestamp > opts.before) continue;
    if (opts.project && exchange.project !== opts.project) continue;
    if (opts.sessionId && exchange.sessionId !== opts.sessionId) continue;
    if (opts.harness && (exchange.harness ?? DEFAULT_HARNESS) !== opts.harness) continue;
    if (exchange.userMessage.toLowerCase().includes(q) || exchange.assistantMessage.toLowerCase().includes(q)) {
      results.push(exchange);
      if (results.length >= opts.limit) break;
    }
  }
  return results;
}
