import { type StoreHandle } from './store.js';
/** LMDB meta key holding the file name (basename) readers should be on. */
export declare const VECTOR_INDEX_FILE_KEY = "vector_index_file";
/** The addon generation is spliced into the file name: `index.hnsw` becomes
 * `index-v2.hnsw`. Two builds with different on-disk layouts then never read
 * each other's file (design doc §10, as for the text index directory). This
 * is the pre-generation name; see generationPath for what is written now. */
export declare function versionedVectorIndexPath(basePath: string): string;
/** `index.hnsw`, generation 3, pid 48213 -> `index-v2.g3-48213.hnsw`. */
export declare function generationPath(basePath: string, generation: number, pid?: number): string;
/** The generation number encoded in an index file name, or undefined. */
export declare function generationOf(file: string): number | undefined;
/** The file the store says readers should be on, or undefined before the first
 * build. Stored as a basename; resolved beside `basePath`. */
export declare function currentIndexFile(store: StoreHandle, basePath: string): string | undefined;
/** Delete the file a build older than versionedVectorIndexPath left at the
 * bare base path. It is a cache, so nothing is lost. */
export declare function removeLegacyVectorIndex(basePath: string): boolean;
/** How long another generation's file may go unwritten before it is pruned.
 * A build that is still in use rewrites its file on every sync that indexes
 * something, so an old mtime means an abandoned generation. */
export declare const VECTOR_INDEX_IDLE_MS: number;
/** A file younger than this may be another sync's build in progress, or one it
 * has just pointed the store at while we were sweeping. Leave it alone. */
export declare const SWEEP_MIN_AGE_MS: number;
/** Remove other files of the current version: not the one the store names, not
 * `keep` (our own), and not anything written in the last minute. Best effort:
 * on Windows a file another process still maps cannot be deleted, so the next
 * rebuild tries again. Returns what was removed. */
export declare function sweepOtherGenerations(store: StoreHandle, basePath: string, keep: string, { now, minAgeMs }?: {
    now?: number;
    minAgeMs?: number;
}): string[];
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
    /** The file `searcher` was opened from. */
    private opened;
    /** A file we tried and failed to open. Not retried until the store names
     * another one, so one bad file does not cost a failed open per search. */
    private rejected;
    private constructor();
    /** `basePath` is the unversioned name, `~/.config/starmemory/index.hnsw`;
     * the file actually used is whatever the store names (currentIndexFile). */
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
    /** Unmap the index file. On Windows a mapped file cannot be deleted, so a
     * process that is done with an index (a test tearing down, a CLI run about
     * to exit) should close rather than wait for garbage collection. Idempotent;
     * search() and size() answer empty afterwards. */
    close(): void;
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
