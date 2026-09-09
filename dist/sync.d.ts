import { type SummaryOptions } from './summaries.js';
import { type StoreHandle } from './store.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex } from './text-index.js';
/** Where each harness keeps its transcripts. The overrides are the ones the
 * harnesses themselves honour, so a profile that moved its config dir still
 * gets indexed. Missing directories are fine: walkJsonlFiles yields nothing. */
export declare function defaultTranscriptDirs(env?: NodeJS.ProcessEnv): string[];
/** Which embedding model every vector in the store came from. */
export declare const EMBEDDING_MODEL_KEY = "embedding_model";
export interface EmbeddingMigrationResult {
    /** Exchanges whose vector was recomputed with the current model. */
    reembedded: number;
}
/** Bring every stored vector onto the current embedding model.
 *
 * Vectors from different models cannot be compared, so a model change means
 * re-embedding the whole store, not just new rows. A store with no recorded
 * model is treated the same way: it predates this check, so its vectors are
 * assumed stale. Subagent turns get no vector, matching insertExchange(). */
export declare function ensureEmbeddingModel(store: StoreHandle): Promise<EmbeddingMigrationResult>;
/** Next exchange id the text index for one schema version has not seen. Kept
 * in LMDB, not in tantivy, because LMDB is the source of truth (design doc §09).
 * One key per schema version, to match the one directory per schema version
 * (versionedTextIndexDir): a v1 and a v2 index each advance their own cursor,
 * so neither mistakes the other's progress for its own. */
export declare function textCursorKey(version: number): string;
export interface TextSyncResult {
    /** Another process held the writer lock. Our rows are in LMDB and whoever
     * takes the lock next will index them, so this is not a failure. */
    skipped: boolean;
    /** The index had no documents although the cursor said rows were indexed:
     * its directory was wiped or is brand new, so every row was reloaded. */
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
export interface SyncOptions {
    /** Where transcript copies live (design doc archive-and-summaries §03).
     * Tests point this at a temp dir; the default is ~/.config/starmemory/archive. */
    archiveRoot?: string;
    /** Summary step settings (design doc archive-and-summaries §04); tests inject
     * fake summarizers here. `limit` defaults to STARMEMORY_SUMMARY_LIMIT or 10. */
    summaries?: SummaryOptions;
    /** Expiry settings (design doc archive-and-summaries §13). `days` defaults to
     * STARMEMORY_TTL_DAYS or 180; 0 disables. `now` is for tests. */
    ttl?: {
        days?: number;
        now?: number;
        log?: (line: string) => void;
    };
}
export interface SyncResult {
    filesScanned: number;
    exchangesIndexed: number;
    /** Transcripts copied into the archive this run. */
    archived: number;
    /** Summary files written this run (including empty sentinels). */
    summarized: number;
    /** Summaries that failed and were left as error sentinels to retry. */
    summaryFailed: number;
    /** Rows removed because their conversation passed the TTL. */
    expired: number;
    /** Conversations (files) removed for the same reason. */
    expiredFiles: number;
    /** True when expiry was skipped because another process held the text writer. */
    expireSkipped: boolean;
    /** Vectors recomputed because the embedding model changed (see ensureEmbeddingModel). */
    reembedded: number;
    /** Documents added to the BM25 index this run. */
    textIndexed: number;
    /** True when another process held the BM25 writer lock (design doc §09). */
    textSkipped: boolean;
}
/** Scans every transcript of every harness, inserts exchanges past each file's
 * last-synced cursor, and rebuilds the vector index once at the end (design doc
 * §07: rebuilding from scratch is a sub-second operation at this scale, so
 * there's no need for incremental graph maintenance). */
export declare function syncAll(store: StoreHandle, index: VectorIndex, transcriptsDirs?: string | string[], textIndex?: TextIndex, options?: SyncOptions): Promise<SyncResult>;
