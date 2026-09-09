import { type NativeTextDoc } from './addon.js';
import type { ConversationExchange, Harness } from './types.js';
/** True when the addon has been built. Callers that can still work without BM25
 * (see store.ts's substring fallback) use this instead of catching a throw. */
export declare function isTextIndexAvailable(): boolean;
export interface TextSearchFilter {
    project?: string;
    sessionId?: string;
    harness?: Harness;
    /** Inclusive ISO 8601 bounds, matching SearchOptions. */
    after?: string;
    before?: string;
}
export interface TextHit {
    id: number;
    score: number;
}
/** One exchange, flattened into the single text field the schema indexes.
 * Both sides go in: people search for what the assistant said at least as often
 * as for what they asked. */
export declare function documentForExchange(exchange: ConversationExchange): NativeTextDoc;
export declare class TextIndex {
    private readonly native;
    readonly directory: string;
    private constructor();
    static open(directory: string): TextIndex;
    /** Schema/analyzer generation of the compiled addon. A stored value that no
     * longer matches this means the index has to be rebuilt (design doc §10). */
    get version(): number;
    /** False means another process is already indexing. Design doc §09: that is a
     * reason to stop, not a reason to fail -- the other process picks up our rows. */
    tryAcquireWriter(): boolean;
    addExchanges(exchanges: ConversationExchange[]): void;
    /** fsyncs and republishes the reader. Expensive, so call it once per batch. */
    commit(): void;
    deleteAll(): void;
    search(query: string, limit: number, filter?: TextSearchFilter): TextHit[];
    numDocs(): number;
}
