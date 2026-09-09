import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
export declare const SUMMARIZER_GUARD = "STARMEMORY_SUMMARIZER_GUARD";
export declare function summarizerEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function isReentrantSummarizerContext(env?: NodeJS.ProcessEnv): boolean;
export type QueryFn = typeof sdkQuery;
export interface ClaudeSummaryInput {
    sessionId?: string;
    /** Claude Code stores a session under ~/.claude/projects/<encoded cwd>/, so
     * resume needs the cwd the conversation ran in. */
    cwd?: string;
    transcript: string;
}
/** Resume the original session first (its context is already there), fall back
 * to the transcript text when it cannot be resumed, and try the fallback model
 * once when the primary hits a thinking-budget error. */
export declare function summarizeWithClaude(input: ClaudeSummaryInput, deps?: {
    query?: QueryFn;
    env?: NodeJS.ProcessEnv;
}): Promise<string>;
