import { type StoreHandle } from './store.js';
/** The addon generation is spliced into the file name: `index.hnsw` becomes
 * `index-v2.hnsw`. Two builds with different on-disk layouts then never read
 * each other's file, even when one is a server that stays up across the
 * upgrade and reopens whatever appears at its path (design doc §10, as for
 * the text index directory). */
export declare function versionedVectorIndexPath(basePath: string): string;
/** Delete the file a build older than versionedVectorIndexPath left at the
 * bare base path. It is a cache, so nothing is lost. */
export declare function removeLegacyVectorIndex(basePath: string): boolean;
/** How long another generation's file may go unwritten before it is pruned.
 * A build that is still in use rewrites its file on every sync that indexes
 * something, so an old mtime means an abandoned generation. */
export declare const VECTOR_INDEX_IDLE_MS: number;
/** Remove other generations' index files that have sat idle. Never touches
 * our own, nor anything not shaped like a sibling of ours. Returns the paths
 * removed. */
export declare function pruneStaleVectorIndexFiles(basePath: string, { now, maxIdleMs }?: {
    now?: number;
    maxIdleMs?: number;
}): string[];
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
    /** The file `searcher` was opened from, so a rebuild by another process
     * (the SessionStart sync while this MCP server is alive) is noticed. */
    private opened;
    /** A replacement we tried and failed to open. Not retried until the file
     * changes again, so one bad file does not cost a failed open per search. */
    private rejected;
    private constructor();
    /** `basePath` is the unversioned name, `~/.config/starmemory/index.hnsw`;
     * the file actually used is versionedVectorIndexPath(basePath). */
    static open(store: StoreHandle, basePath: string, options?: Partial<HnswOptions>): VectorIndex;
    /** Rebuild the whole graph from every vector currently in LMDB.
     *
     * Wholesale rather than incremental on purpose (design doc §07): inserting
     * into an HNSW graph degrades it, and at this corpus size a full rebuild is a
     * sub-second operation. Subagent turns never appear here because store.ts
     * gives them no vector. */
    rebuild(store: StoreHandle): void;
    /** `identity` is taken before the open on purpose: if the file is replaced
     * between the two, we record the older one and merely reopen once more on the
     * next refresh(); recording the newer one could leave us on a stale mapping. */
    private openSearcher;
    /** Reopen if the file on disk is no longer the one we mapped. A reader keeps
     * its old graph until then (the rename in vector.rs keeps that inode alive),
     * so an unreadable replacement leaves the current searcher in place.
     *
     * Called by the query layer once per query, not per search(): a multi-concept
     * query runs several searches and they must all see one graph. */
    refresh(): void;
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
