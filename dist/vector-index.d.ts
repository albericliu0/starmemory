import { type StoreHandle } from './store.js';
export interface HnswOptions {
    dim: number;
    /** HNSW's M: graph connectivity. */
    connectivity: number;
    expansionAdd: number;
    expansionSearch: number;
}
export declare class VectorIndex {
    private readonly indexPath;
    private readonly options;
    private searcher;
    private constructor();
    static open(store: StoreHandle, indexPath: string, options?: Partial<HnswOptions>): VectorIndex;
    /** Rebuild the whole graph from every vector currently in LMDB.
     *
     * Wholesale rather than incremental on purpose (design doc §07): inserting
     * into an HNSW graph degrades it, and at this corpus size a full rebuild is a
     * sub-second operation. Subagent turns never appear here because store.ts
     * gives them no vector. */
    rebuild(store: StoreHandle): void;
    /** Top-k by cosine similarity, optionally restricted to `filterIds`.
     *
     * The filter runs inside the graph traversal, so a filtered query does not
     * over-fetch and trim (design doc §07/§08). */
    search(query: Float32Array, k: number, filterIds?: number[]): {
        id: number;
        score: number;
    }[];
    /** Vectors currently in the graph. */
    size(): number;
}
