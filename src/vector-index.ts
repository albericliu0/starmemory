// Wraps the native HNSW addon -- design doc §07. The index file is a rebuildable
// cache, not source of truth (that's `vectors` in store.ts): on open(), load the
// on-disk index if present, otherwise rebuild it from every vector in LMDB.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { EMBEDDING_DIM } from './embeddings.js';
import { allVectors, type StoreHandle } from './store.js';

const require = createRequire(import.meta.url);
const native = require('../native/build/Release/starmemory_native.node') as {
  buildHnswIndex(
    options: HnswOptions,
    vectors: Float32Array,
    ids: BigInt64Array,
    outputPath: string
  ): void;
  HnswSearcher: new (
    options: HnswOptions,
    indexPath: string
  ) => { search(query: Float32Array, k: number, filterIds?: BigInt64Array): SearchResultRaw };
};

export interface HnswOptions {
  dim: number;
  metric: 'l2' | 'cosine' | 'inner_product' | 'cosine_distance';
  isVectorNormed?: boolean;
  M?: number;
  efConstruction?: number;
  efSearch?: number;
}

interface SearchResultRaw {
  ids: BigInt64Array;
  distances: Float32Array;
}

const DEFAULT_OPTIONS: HnswOptions = {
  dim: EMBEDDING_DIM,
  metric: 'inner_product', // embeddings are already L2-normalized, so IP == cosine
  isVectorNormed: true,
  M: 16,
  efConstruction: 40,
  efSearch: 64,
};

export class VectorIndex {
  private searcher: InstanceType<typeof native.HnswSearcher> | null = null;

  private constructor(
    private readonly indexPath: string,
    private readonly options: HnswOptions
  ) {}

  static open(store: StoreHandle, indexPath: string, options: Partial<HnswOptions> = {}): VectorIndex {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const index = new VectorIndex(indexPath, opts);
    if (fs.existsSync(indexPath)) {
      try {
        index.searcher = new native.HnswSearcher(opts, indexPath);
        return index;
      } catch {
        // fall through to rebuild -- e.g. index file from an incompatible tenann version
      }
    }
    index.rebuild(store);
    return index;
  }

  /** Rebuild the whole graph from every vector currently in LMDB (design doc §07:
   * "几万条向量构图是秒级操作, 不是需要焦虑的成本"). Call after a sync batch. */
  rebuild(store: StoreHandle): void {
    const ids: number[] = [];
    const vecs: number[] = [];
    for (const { id, vector } of allVectors(store, this.options.dim)) {
      ids.push(id);
      vecs.push(...vector);
    }
    if (ids.length === 0) {
      this.searcher = null;
      return;
    }
    native.buildHnswIndex(
      this.options,
      Float32Array.from(vecs),
      BigInt64Array.from(ids.map(BigInt)),
      this.indexPath
    );
    this.searcher = new native.HnswSearcher(this.options, this.indexPath);
  }

  /** Top-k search, optionally restricted to `filterIds` via tenann's ArrayIdFilter
   * (design doc §07/§08 -- no post-hoc over-fetch-and-trim). */
  search(query: Float32Array, k: number, filterIds?: number[]): { id: number; score: number }[] {
    if (!this.searcher) return [];
    const raw = this.searcher.search(
      query,
      k,
      filterIds ? BigInt64Array.from(filterIds.map(BigInt)) : undefined
    );
    const out: { id: number; score: number }[] = [];
    for (let i = 0; i < raw.ids.length; i++) {
      out.push({ id: Number(raw.ids[i]), score: raw.distances[i] });
    }
    return out;
  }
}
