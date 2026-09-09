export declare const MIN_CODEX_VERSION = "0.130.0";
export declare function parseCodexVersion(output: string): string | undefined;
export declare function versionAtLeast(version: string, minimum?: string): boolean;
export interface CodexSummaryInput {
    /** The Codex session id, which app-server calls the thread id. */
    threadId?: string;
    transcript: string;
}
export interface CodexDeps {
    /** May carry leading arguments ("node fake.mjs"), so tests can stand in a script. */
    bin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}
export declare function summarizeWithCodex(input: CodexSummaryInput, deps?: CodexDeps): Promise<string>;
