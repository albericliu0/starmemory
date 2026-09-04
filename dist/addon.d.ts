/** Built by `npm run build:native`. `dist/` and `src/` sit at the same depth
 * relative to the crate, so one relative path serves both. */
export declare const ADDON_PATH: string;
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
    TextIndex: {
        open(path: string): NativeTextIndex;
    };
    indexVersion(): number;
    buildVectorIndex(options: NativeVectorOptions, ids: Float64Array, vectors: Float32Array, path: string): void;
    VectorSearcher: {
        open(options: NativeVectorOptions, path: string): NativeVectorSearcher;
    };
    vectorIndexVersion(): number;
}
export declare function isAddonAvailable(): boolean;
export declare function addon(): NativeAddon;
