// LMDB storage layer -- design doc §05.
//
// Five sub-databases in one LMDB environment:
//   exchanges   : id -> ConversationExchange (JSON)
//   vectors     : id -> normalized embedding (Float32Array, `dim` elements)
//   idx_project : [project, id] -> null           (secondary index)
//   idx_session : [sessionId, id] -> null          (secondary index)
//   idx_time    : [timestamp, id] -> null          (secondary index)
//   meta        : string key -> scalar value       (cursors, versions)
//
// Numeric ids are plain JS numbers (lmdb-js orders numeric keys correctly,
// so an ascending id also reads back in insertion order -- no manual
// big-endian encoding needed, unlike the raw-LMDB-C design in the doc).
import { open, type RootDatabase, type Database } from 'lmdb';
import path from 'node:path';
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

export function openStore(dbPath: string): StoreHandle {
  const root = open({ path: path.resolve(dbPath) });
  const exchanges = root.openDB<string, number>({ name: 'exchanges' });
  const vectors = root.openDB<Buffer, number>({ name: 'vectors' });
  const idxProject = root.openDB<null, [string, number]>({ name: 'idx_project' });
  const idxSession = root.openDB<null, [string, number]>({ name: 'idx_session' });
  // ISO 8601 strings sort lexicographically in chronological order, so a plain
  // range scan answers a date filter without parsing a single exchange.
  const idxTime = root.openDB<null, [string, number]>({ name: 'idx_time' });
  const meta = root.openDB<unknown, string>({ name: 'meta' });

  return {
    root,
    exchanges,
    vectors,
    idxProject,
    idxSession,
    idxTime,
    meta,
    close: () => root.close(),
  };
}

/** Next id = current max id in `exchanges` + 1 (0 for an empty store). Used
 * both as the primary key and, per design doc §12, as the sync cursor. */
export function nextId(store: StoreHandle): number {
  let max = -1;
  for (const { key } of store.exchanges.getRange({ reverse: true, limit: 1 })) {
    max = key;
  }
  return max + 1;
}

export function insertExchange(
  store: StoreHandle,
  exchange: Omit<ConversationExchange, 'id'>,
  embedding: Float32Array | null
): number {
  const id = nextId(store);
  const full: ConversationExchange = { ...exchange, id };

  // Subagent turns are kept so `read` can show a whole conversation, but they get
  // no vector. Leaving them out of the vector store is what keeps them out of the
  // HNSW graph entirely, instead of filtering them off the end of every search.
  const storeVector = embedding !== null && exchange.isSidechain !== true;

  store.root.transactionSync(() => {
    store.exchanges.putSync(id, JSON.stringify(full));
    if (storeVector) {
      store.vectors.putSync(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    }
    store.idxProject.putSync([exchange.project, id], null);
    if (exchange.sessionId) {
      store.idxSession.putSync([exchange.sessionId, id], null);
    }
    if (exchange.timestamp) {
      store.idxTime.putSync([exchange.timestamp, id], null);
    }
  });

  return id;
}

export function getExchange(store: StoreHandle, id: number): ConversationExchange | undefined {
  const raw = store.exchanges.get(id);
  return raw ? (JSON.parse(raw) as ConversationExchange) : undefined;
}

/** A vector written by a different embedding model has a different byte length.
 * Reading it at the current `dim` would produce garbage, so such rows are treated
 * as absent until ensureEmbeddingModel() rewrites them. */
function vectorOfDim(buf: Buffer, dim: number): Float32Array | undefined {
  if (buf.byteLength !== dim * 4) return undefined;
  return new Float32Array(buf.buffer, buf.byteOffset, dim);
}

export function getVector(store: StoreHandle, id: number, dim: number): Float32Array | undefined {
  const buf = store.vectors.get(id);
  return buf ? vectorOfDim(buf, dim) : undefined;
}

export function putVector(store: StoreHandle, id: number, embedding: Float32Array): void {
  store.vectors.putSync(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
}

/** All (id, vector) pairs of the current dimension, for a full index rebuild
 * (design doc §07). Stale-model vectors are skipped, not misread. */
export function* allVectors(store: StoreHandle, dim: number): Generator<{ id: number; vector: Float32Array }> {
  for (const { key, value } of store.vectors.getRange()) {
    const vector = vectorOfDim(value, dim);
    if (vector) yield { id: key, vector };
  }
}

/** ids whose exchange matches the given filters (design doc §07's "元数据过滤"
 * -> ArrayIdFilter path). Every clause is answered from a secondary index, so
 * this stays cheap enough to run before the graph traversal rather than after it.
 *
 * Returns undefined when no filter was requested, so callers can tell "no filter"
 * apart from "filter matched nothing". */
export function filterIds(
  store: StoreHandle,
  filters: { project?: string; sessionId?: string; after?: string; before?: string }
): number[] | undefined {
  const { project, sessionId, after, before } = filters;
  if (!project && !sessionId && !after && !before) return undefined;

  const sets: Set<number>[] = [];

  if (project) {
    sets.push(idsInRange(store.idxProject, [project, -Infinity], [project, Infinity]));
  }
  if (sessionId) {
    sets.push(idsInRange(store.idxSession, [sessionId, -Infinity], [sessionId, Infinity]));
  }
  if (after || before) {
    sets.push(
      idsInRange(
        store.idxTime,
        after ? [after, -Infinity] : undefined,
        before ? [before, Infinity] : undefined
      )
    );
  }

  let result = sets[0];
  for (let i = 1; i < sets.length; i++) {
    result = new Set([...result].filter((id) => sets[i].has(id)));
  }
  return [...result].sort((a, b) => a - b);
}

function idsInRange(
  db: Database<null, [string, number]>,
  start?: [string, number],
  end?: [string, number]
): Set<number> {
  const ids = new Set<number>();
  const range: { start?: [string, number]; end?: [string, number] } = {};
  if (start) range.start = start;
  if (end) range.end = end;
  for (const { key } of db.getRange(range)) {
    ids.add(key[1]);
  }
  return ids;
}

/** Every exchange with an id at or above `fromId`, in id order. This is how the
 * text index catches up from its cursor (design doc §09). */
export function exchangesFrom(store: StoreHandle, fromId: number): ConversationExchange[] {
  const out: ConversationExchange[] = [];
  for (const { value } of store.exchanges.getRange({ start: fromId })) {
    out.push(JSON.parse(value) as ConversationExchange);
  }
  return out;
}

/** Substring search over exchange text, with optional date/project/session filters
 * applied post-hoc (design doc §07: "text 检索... 照抄, 对 exchanges sub-DB 做 cursor
 * 遍历做子串匹配"). O(n) full scan -- fine at the thousands-to-tens-of-thousands scale
 * this engine targets (see design doc §04). */
export function textSearch(
  store: StoreHandle,
  query: string,
  opts: { after?: string; before?: string; project?: string; sessionId?: string; limit: number }
): ConversationExchange[] {
  const q = query.toLowerCase();
  const results: ConversationExchange[] = [];
  for (const { value } of store.exchanges.getRange({ reverse: true })) {
    const exchange = JSON.parse(value) as ConversationExchange;
    if (exchange.isSidechain) continue; // subagent turns: stored, excluded from search by default
    if (opts.after && exchange.timestamp < opts.after) continue;
    if (opts.before && exchange.timestamp > opts.before) continue;
    if (opts.project && exchange.project !== opts.project) continue;
    if (opts.sessionId && exchange.sessionId !== opts.sessionId) continue;
    if (
      exchange.userMessage.toLowerCase().includes(q) ||
      exchange.assistantMessage.toLowerCase().includes(q)
    ) {
      results.push(exchange);
      if (results.length >= opts.limit) break;
    }
  }
  return results;
}
