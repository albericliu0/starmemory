/** Built by `npm run build:native`. `dist/` and `src/` sit at the same depth
 * relative to the crate, so one relative path serves both. */
export declare const ADDON_PATH: string;
export interface NativeTextDoc {
    id: number;
    text: string;
    project: string;
    sessionId: string;
    harness: string;
    timestampMs: number;
    isSidechain: boolean;
}
export interface NativeTextFilter {
    project?: string;
    sessionId?: string;
    harness?: string;
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
    /** Queue these ids for removal; commit() applies it. Needs the writer. */
    deleteDocuments(ids: Float64Array): void;
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
    /** Unmap the file now. Idempotent; search() and len() throw afterwards. */
    close(): void;
}
export interface NativeStoreRow {
    json: string;
    project: string;
    sessionId?: string;
    timestamp: string;
    lineEnd: number;
    isSidechain: boolean;
    embedding?: Float32Array;
    harness?: string;
}
export interface NativeInsertResult {
    ids: number[];
    skipped: number;
}
export interface NativeStore {
    insert(rows: NativeStoreRow[], cursorKey: string | null): NativeInsertResult;
    /** Remove rows, their vectors and index entries in one transaction; returns how many existed. */
    delete(ids: Float64Array): number;
    get(id: number): string | null;
    getVector(id: number): Float32Array | null;
    putVector(id: number, vector: Float32Array): void;
    allVectors(dim: number): {
        ids: Float64Array;
        data: Float32Array;
    };
    filterIds(filter: {
        project?: string;
        sessionId?: string;
        harness?: string;
        after?: string;
        before?: string;
    }): Float64Array | null;
    reindexHarness(): number;
    exchangesFrom(from: number): string[];
    nextId(): number;
    metaGet(key: string): string | null;
    metaPut(key: string, value: string): void;
    metaRemove(key: string): boolean;
    close(): void;
}
export interface NativeAddon {
    StoreHandle: {
        open(path: string): NativeStore;
    };
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
