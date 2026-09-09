import { type StoreHandle } from './store.js';
import type { TextIndex } from './text-index.js';
export declare const DEFAULT_TTL_DAYS = 180;
/** `STARMEMORY_TTL_DAYS`; 0 (or a non-number) disables expiry. */
export declare function defaultTtlDays(env?: NodeJS.ProcessEnv): number;
export declare function ttlCutoffMs(ttlDays: number, now?: number): number;
export interface ExpireOptions {
    ttlDays?: number;
    now?: number;
    archiveRoot: string;
    log?: (line: string) => void;
}
export interface ExpireResult {
    /** Rows removed from the store. */
    rows: number;
    /** Conversations (archive files) removed. */
    files: number;
    /** True when another process held the text writer, so nothing was done this run. */
    skipped: boolean;
}
/** Remove every conversation whose last activity is older than the TTL. Holds
 * the text writer for the duration when a text index is given; if another
 * process has it, nothing is removed this run and the next sync tries again. */
export declare function expireOldConversations(store: StoreHandle, textIndex: TextIndex | undefined, { ttlDays, now, archiveRoot, log }: ExpireOptions): ExpireResult;
