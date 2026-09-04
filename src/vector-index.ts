// HNSW vector search -- design doc §07.
//
// Backed by usearch inside the single Rust addon. The index file is a
// rebuildable cache, not source of truth: that is `vectors` in store.ts. On
// open() we load the file if it is there and usable, otherwise we rebuild from
// every vector in LMDB.
import fs from 'node:fs';
import { EMBEDDING_DIM } from './embeddings.js';
import { allVectors, type StoreHandle } from './store.js';
import { addon, type NativeVectorOptions, type NativeVectorSearcher } from './addon.js';

/** Which addon generation built the index file on disk. Bumped in vector.rs
 * whenever the on-disk layout or graph parameters change; a mismatch means the
 * file can still open but must not be trusted, so it is rebuilt (design doc §10). */
export const VECTOR_INDEX_VERSION_KEY = 'vector_index_version';

export interface HnswOptions {
  dim: number;
  /** HNSW's M: graph connectivity. */
  connectivity: number;
  expansionAdd: number;
  expansionSearch: number;
}

/** Unchanged from the faiss build, so recall stays comparable. Embeddings are
 * already L2-normalised, so the engine's inner product is cosine similarity. */
const DEFAULT_OPTIONS: HnswOptions = {
  dim: EMBEDDING_DIM,
  connectivity: 16,
  expansionAdd: 40,
  expansionSearch: 64,
};

function toNative(options: HnswOptions): NativeVectorOptions {
  return {
    dim: options.dim,
    connectivity: options.connectivity,
    expansionAdd: options.expansionAdd,
    expansionSearch: options.expansionSearch,
  };
}

export class VectorIndex {
  private searcher: NativeVectorSearcher | null = null;

  private constructor(
    private readonly indexPath: string,
    private readonly options: HnswOptions
  ) {}

  static open(store: StoreHandle, indexPath: string, options: Partial<HnswOptions> = {}): VectorIndex {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const index = new VectorIndex(indexPath, opts);
    const recorded = store.meta.get(VECTOR_INDEX_VERSION_KEY) as number | undefined;
    const current = addon().vectorIndexVersion();
    if (fs.existsSync(indexPath) && recorded === current) {
      try {
        index.searcher = addon().VectorSearcher.open(toNative(opts), indexPath);
        return index;
      } catch {
        // An index file from an incompatible version. It is a cache, so drop it.
      }
    }
    index.rebuild(store);
    return index;
  }

  /** Rebuild the whole graph from every vector currently in LMDB.
   *
   * Wholesale rather than incremental on purpose (design doc §07): inserting
   * into an HNSW graph degrades it, and at this corpus size a full rebuild is a
   * sub-second operation. Subagent turns never appear here because store.ts
   * gives them no vector. */
  rebuild(store: StoreHandle): void {
    const ids: number[] = [];
    const chunks: Float32Array[] = [];
    for (const { id, vector } of allVectors(store, this.options.dim)) {
      ids.push(id);
      chunks.push(vector);
    }

    const flat = new Float32Array(ids.length * this.options.dim);
    chunks.forEach((vector, i) => flat.set(vector, i * this.options.dim));

    addon().buildVectorIndex(toNative(this.options), Float64Array.from(ids), flat, this.indexPath);
    this.searcher = addon().VectorSearcher.open(toNative(this.options), this.indexPath);
    store.meta.putSync(VECTOR_INDEX_VERSION_KEY, addon().vectorIndexVersion());
  }

  /** Top-k by cosine similarity, optionally restricted to `filterIds`.
   *
   * The filter runs inside the graph traversal, so a filtered query does not
   * over-fetch and trim (design doc §07/§08). */
  search(query: Float32Array, k: number, filterIds?: number[]): { id: number; score: number }[] {
    if (!this.searcher) return [];
    return this.searcher.search(
      query,
      k,
      filterIds ? Float64Array.from(filterIds) : null
    );
  }

  /** Vectors currently in the graph. */
  size(): number {
    return this.searcher ? this.searcher.len() : 0;
  }
}
