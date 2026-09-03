import { type StoreHandle } from './store.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex } from './text-index.js';
/** Next exchange id the text index has not seen. Kept in LMDB, not in tantivy,
 * because LMDB is the source of truth (design doc §09). */
export declare const TEXT_CURSOR_KEY = "text_index_cursor";
/** Schema/analyzer generation the current index was built with (design doc §10). */
export declare const TEXT_VERSION_KEY = "text_index_version";
export interface TextSyncResult {
    /** Another process held the writer lock. Our rows are in LMDB and whoever
     * takes the lock next will index them, so this is not a failure. */
    skipped: boolean;
    /** The addon's schema changed under an existing index, so it was thrown away. */
    rebuilt: boolean;
    indexed: number;
}
/** Bring the BM25 index up to date with LMDB.
 *
 * The whole design of this function is "whoever gets the lock does the work
 * everyone else could not do". A process that cannot take the lock returns
 * immediately without touching the cursor, so its rows stay pending and the next
 * lock holder indexes them from the cursor forward (design doc §09). */
export declare function syncTextIndex(store: StoreHandle, index: TextIndex): TextSyncResult;
export interface SyncResult {
    filesScanned: number;
    exchangesIndexed: number;
    /** Documents added to the BM25 index this run. */
    textIndexed: number;
    /** True when another process held the BM25 writer lock (design doc §09). */
    textSkipped: boolean;
}
/** Scans every transcript, inserts exchanges past each file's last-synced
 * cursor, and rebuilds the vector index once at the end (design doc §07:
 * rebuilding from scratch is a sub-second operation at this scale, so there's
 * no need for incremental graph maintenance). */
export declare function syncAll(store: StoreHandle, index: VectorIndex, transcriptsDir?: string, textIndex?: TextIndex): Promise<SyncResult>;
