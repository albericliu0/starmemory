import { type StoreHandle } from './store.js';
export interface HnswOptions {
    dim: number;
    metric: 'l2' | 'cosine' | 'inner_product' | 'cosine_distance';
    isVectorNormed?: boolean;
    M?: number;
    efConstruction?: number;
    efSearch?: number;
}
export declare class VectorIndex {
    private readonly indexPath;
    private readonly options;
    private searcher;
    private constructor();
    static open(store: StoreHandle, indexPath: string, options?: Partial<HnswOptions>): VectorIndex;
    /** Rebuild the whole graph from every vector currently in LMDB (design doc §07:
     * "几万条向量构图是秒级操作, 不是需要焦虑的成本"). Call after a sync batch. */
    rebuild(store: StoreHandle): void;
    /** Top-k search, optionally restricted to `filterIds` via tenann's ArrayIdFilter
     * (design doc §07/§08 -- no post-hoc over-fetch-and-trim). */
    search(query: Float32Array, k: number, filterIds?: number[]): {
        id: number;
        score: number;
    }[];
}
