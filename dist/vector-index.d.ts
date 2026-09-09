import { type StoreHandle } from './store.js';
/** LMDB meta key holding the generation readers should be on. */
export declare const VECTOR_GENERATION_KEY = "vector_index_generation";
/** The addon generation is spliced into the file name: `index.hnsw` becomes
 * `index-v2.hnsw`. Two builds with different on-disk layouts then never read
 * each other's file (design doc §10, as for the text index directory). This
 * is the pre-generation name; see generationPath for what is written now. */
export declare function versionedVectorIndexPath(basePath: string): string;
/** `index.hnsw` + generation 3 -> `index-v2.g3.hnsw`. */
export declare function generationPath(basePath: string, generation: number): string;
/** The generation the store says is current, or undefined before the first build. */
export declare function currentGeneration(store: StoreHandle): number | undefined;
/** Delete the file a build older than versionedVectorIndexPath left at the
 * bare base path. It is a cache, so nothing is lost. */
export declare function removeLegacyVectorIndex(basePath: string): boolean;
/** How long another generation's file may go unwritten before it is pruned.
 * A build that is still in use rewrites its file on every sync that indexes
 * something, so an old mtime means an abandoned generation. */
export declare const VECTOR_INDEX_IDLE_MS: number;
/** Remove other generations of the current version. Best effort: on Windows a
 * file another process still maps cannot be deleted, so the next rebuild tries
 * again. Returns what was removed. */
export declare function sweepOtherGenerations(basePath: string, keep: number): string[];
/** Remove other *versions'* index files that have sat idle. Never touches the
 * current version's files, nor anything not shaped like a sibling of ours.
 * Returns the paths removed. */
export declare function pruneStaleVectorIndexFiles(basePath: string, { now, maxIdleMs }?: {
    now?: number;
    maxIdleMs?: number;
}): string[];
/** Unchanged from the faiss build, so recall stays comparable. Embeddings are
 * already L2-normalised, so the engine's inner product is cosine similarity. */
export interface HnswOptions {
    dim: number;
    /** HNSW's M: graph connectivity. */
    connectivity: number;
    expansionAdd: number;
    expansionSearch: number;
}
export declare class VectorIndex {
    private readonly store;
    private readonly basePath;
    private readonly options;
    private searcher;
    /** The generation `searcher` was opened from. */
    private opened;
    /** A generation we tried and failed to open. Not retried until the store
     * names another one, so one bad file does not cost a failed open per search. */
    private rejected;
    private constructor();
    /** `basePath` is the unversioned name, `~/.config/starmemory/index.hnsw`;
     * the file actually used is generationPath(basePath, currentGeneration). */
    static open(store: StoreHandle, basePath: string, options?: Partial<HnswOptions>): VectorIndex;
    /** Rebuild the whole graph from every vector currently in LMDB into the next
     * generation, then point the store at it and drop the older files.
     *
     * Wholesale rather than incremental on purpose (design doc §07): inserting
     * into an HNSW graph degrades it, and at this corpus size a full rebuild is a
     * sub-second operation. Subagent turns never appear here because store.ts
     * gives them no vector. */
    rebuild(store: StoreHandle): void;
    private openSearcher;
    /** Switch to the generation the store names if it is not the one we have. A
     * reader keeps its old graph until then; the old file stays on disk at least
     * until we let go of it, so an unreadable replacement leaves the current
     * searcher in place.
     *
     * Called by the query layer once per query, not per search(): a multi-concept
     * query runs several searches and they must all see one graph. */
    refresh(): void;
    /** The file the current searcher was opened from. */
    get currentPath(): string | null;
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
