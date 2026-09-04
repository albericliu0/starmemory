// Loader for the single Rust native addon.
//
// One module now covers both retrieval paths: Tantivy BM25 (engine.rs) and
// usearch HNSW (vector.rs). It replaces the earlier split between a vendored
// C++ faiss/tenann addon and a separate Rust one -- one crate, one toolchain,
// and no external OpenMP runtime to locate at load time.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** Built by `npm run build:native`. `dist/` and `src/` sit at the same depth
 * relative to the crate, so one relative path serves both. */
export const ADDON_PATH = path.resolve(here, '..', 'native', 'starmemory_native.node');

export interface NativeTextDoc {
  id: number;
  text: string;
  project: string;
  sessionId: string;
  timestampMs: number;
  isSidechain: boolean;
}

export interface NativeTextFilter {
  project?: string;
  sessionId?: string;
  afterMs?: number;
  beforeMs?: number;
}

export interface NativeHit {
  id: number;
  score: number;
}

export interface NativeTextIndex {
  tryAcquireWriter(): boolean;
  addDocuments(docs: NativeTextDoc[]): void;
  commit(): void;
  deleteAll(): void;
  search(query: string, limit: number, filter: NativeTextFilter | null): NativeHit[];
  numDocs(): number;
}

export interface NativeVectorOptions {
  dim: number;
  connectivity: number;
  expansionAdd: number;
  expansionSearch: number;
}

export interface NativeVectorSearcher {
  search(query: Float32Array, limit: number, filterIds?: Float64Array | null): NativeHit[];
  len(): number;
}

export interface NativeAddon {
  TextIndex: { open(path: string): NativeTextIndex };
  indexVersion(): number;
  buildVectorIndex(
    options: NativeVectorOptions,
    ids: Float64Array,
    vectors: Float32Array,
    path: string
  ): void;
  VectorSearcher: { open(options: NativeVectorOptions, path: string): NativeVectorSearcher };
  vectorIndexVersion(): number;
}

let cached: NativeAddon | null = null;

export function isAddonAvailable(): boolean {
  return fs.existsSync(ADDON_PATH);
}

export function addon(): NativeAddon {
  if (!cached) {
    if (!fs.existsSync(ADDON_PATH)) {
      throw new Error(`starmemory native addon not found at ${ADDON_PATH} -- run "npm run build:native"`);
    }
    cached = require(ADDON_PATH) as NativeAddon;
  }
  return cached;
}
