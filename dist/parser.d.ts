import type { ParsedExchange } from './types.js';
export declare function isInjectedUserTurn(entry: {
    promptSource?: string;
    isMeta?: boolean;
}, text: string): boolean;
/** The part of an injected block worth indexing. Returns '' when there is none,
 * which is the honest answer for a system reminder: it is an instruction to the
 * model, not something anyone would search for. */
export declare function payloadOfInjectedTurn(text: string): string;
export declare function parseConversation(filePath: string, project: string, archivePath: string): Promise<ParsedExchange[]>;
/** Derives a project name the same way episodic-memory does: the JSONL file's
 * parent directory name (Claude Code's sanitized-cwd slug). */
export declare function projectFromPath(filePath: string): string;
