// Wraps the native HNSW addon -- design doc §07. The index file is a rebuildable
// cache, not source of truth (that's `vectors` in store.ts): on open(), load the
// on-disk index if present, otherwise rebuild it from every vector in LMDB.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { EMBEDDING_DIM } from './embeddings.js';
import { allVectors } from './store.js';
const require = createRequire(import.meta.url);
const native = require('../native/build/Release/starmemory_native.node');
const DEFAULT_OPTIONS = {
    dim: EMBEDDING_DIM,
    metric: 'inner_product', // embeddings are already L2-normalized, so IP == cosine
    isVectorNormed: true,
    M: 16,
    efConstruction: 40,
    efSearch: 64,
};
export class VectorIndex {
    indexPath;
    options;
    searcher = null;
    constructor(indexPath, options) {
        this.indexPath = indexPath;
        this.options = options;
    }
    static open(store, indexPath, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const index = new VectorIndex(indexPath, opts);
        if (fs.existsSync(indexPath)) {
            try {
                index.searcher = new native.HnswSearcher(opts, indexPath);
                return index;
            }
            catch {
                // fall through to rebuild -- e.g. index file from an incompatible tenann version
            }
        }
        index.rebuild(store);
        return index;
    }
    /** Rebuild the whole graph from every vector currently in LMDB (design doc §07:
     * "几万条向量构图是秒级操作, 不是需要焦虑的成本"). Call after a sync batch. */
    rebuild(store) {
        const ids = [];
        const vecs = [];
        for (const { id, vector } of allVectors(store, this.options.dim)) {
            ids.push(id);
            vecs.push(...vector);
        }
        if (ids.length === 0) {
            this.searcher = null;
            return;
        }
        native.buildHnswIndex(this.options, Float32Array.from(vecs), BigInt64Array.from(ids.map(BigInt)), this.indexPath);
        this.searcher = new native.HnswSearcher(this.options, this.indexPath);
    }
    /** Top-k search, optionally restricted to `filterIds` via tenann's ArrayIdFilter
     * (design doc §07/§08 -- no post-hoc over-fetch-and-trim). */
    search(query, k, filterIds) {
        if (!this.searcher)
            return [];
        const raw = this.searcher.search(query, k, filterIds ? BigInt64Array.from(filterIds.map(BigInt)) : undefined);
        const out = [];
        for (let i = 0; i < raw.ids.length; i++) {
            out.push({ id: Number(raw.ids[i]), score: raw.distances[i] });
        }
        return out;
    }
}
