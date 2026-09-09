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
/** Where the index for the addon's current schema lives, given the unversioned
 * base path (`.../text` -> `.../text-v2`). Each schema generation gets a sibling
 * directory of its own, so a plugin build with a different schema opens a
 * different directory instead of tripping over, or wiping, this one. Two builds
 * sharing `~/.config/starmemory` (say, the installed plugin and a dev checkout)
 * then coexist, each rebuilding its own index from LMDB (design doc §10). */
export declare function versionedTextIndexDir(basePath: string): string;
/** Delete the index a build older than versionedTextIndexDir left at the bare
 * base path. Only a directory that really is a tantivy index (it has a
 * meta.json) is removed; anything else at that path is not ours to touch.
 * Returns true when something was removed. */
export declare function removeLegacyTextIndex(basePath: string): boolean;
/** What the CLI and the MCP server call: open this build's own index directory
 * under the configured base path, tidying up the pre-versioning one if present. */
export declare function openVersionedTextIndex(basePath: string): TextIndex;
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
