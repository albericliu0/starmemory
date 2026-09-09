import type { ConversationExchange, Harness, ParsedExchange } from './types.js';
export declare const QUIET_MS: number;
export declare const DEFAULT_SUMMARY_LIMIT = 10;
export declare const SUMMARY_DISPLAY_MAX_CHARS = 300;
export declare const ERROR_PREFIX = "[error]";
export type SummaryState = {
    kind: 'missing';
} | {
    kind: 'empty';
} | {
    kind: 'error';
    message: string;
} | {
    kind: 'valid';
    text: string;
};
export declare function readSummaryState(summaryPath: string): SummaryState;
/** An empty `text` writes the empty sentinel: nothing here to summarise, do not ask again. */
export declare function writeSummary(summaryPath: string, text: string): void;
/** Retried on the next sync; the reason is kept so a person can see why. */
export declare function writeErrorSentinel(summaryPath: string, error: unknown): void;
export interface SummaryCandidate {
    archivePath: string;
    harness: Harness;
    project: string;
    sessionId?: string;
    sourceMtimeMs: number;
}
/** Quiet for long enough, not yet summarised (or the last try failed), newest
 * first, at most `limit`. */
export declare function selectForSummary(candidates: SummaryCandidate[], { now, quietMs, limit }?: {
    now?: number;
    quietMs?: number;
    limit?: number;
}): SummaryCandidate[];
/** The conversation as plain text for a model that cannot resume the session.
 * Over `maxChars`, keep the opening and the ending: how it started and how it
 * ended is what a summary needs most. */
export declare function transcriptText(exchanges: ParsedExchange[], maxChars?: number): string;
/** Asks for the summary inside <summary></summary>. A resumed session tends to
 * treat a bare instruction as one more turn of the conversation and answer in
 * character ("I'm ready to help. What next?"); the tags are how we tell a
 * summary from chatter, see extractSummary. */
export declare const SUMMARY_PROMPT: string;
/** The text inside the first <summary> block, or undefined when there is none.
 * Callers decide what "none" means: the resume path treats it as a failed
 * attempt, the plain-text path accepts the raw reply. */
export declare function extractSummary(reply: string): string | undefined;
/** What the search result shows: a valid summary short enough to sit above the
 * snippet. Rows from before the archive point at the source file, so look the
 * summary up through the archive layout, not the stored path. */
export declare function summaryFor(exchange: ConversationExchange, archiveRoot: string): string | undefined;
export interface Summarizers {
    claude: (input: {
        sessionId?: string;
        cwd?: string;
        transcript: string;
    }) => Promise<string>;
    codex: (input: {
        threadId?: string;
        transcript: string;
    }) => Promise<string>;
}
export interface SummaryOptions {
    limit?: number;
    now?: number;
    quietMs?: number;
    /** Injected by tests; the defaults are the real Agent SDK and codex app-server clients. */
    summarizers?: Summarizers;
    log?: (line: string) => void;
}
export interface SummaryRunResult {
    attempted: number;
    written: number;
    failed: number;
}
export declare function summarizeQuietConversations(candidates: SummaryCandidate[], opts?: SummaryOptions): Promise<SummaryRunResult>;
