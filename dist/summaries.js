// Summaries: a few sentences beside each archived conversation, for a person
// deciding whether to open it. Never indexed. Written only once a conversation
// has been quiet for QUIET_MS, so a session that runs for days is summarised
// whole rather than after its first two turns. Design doc archive-and-summaries §04.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { archivePathFor, openArchive, summaryPathFor } from './archive.js';
import { parseConversation } from './parser.js';
export const QUIET_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SUMMARY_LIMIT = 10;
export const SUMMARY_DISPLAY_MAX_CHARS = 300;
export const ERROR_PREFIX = '[error]';
export function readSummaryState(summaryPath) {
    let raw;
    try {
        raw = fs.readFileSync(summaryPath, 'utf8');
    }
    catch {
        return { kind: 'missing' };
    }
    const text = raw.trim();
    if (text === '')
        return { kind: 'empty' };
    if (text.startsWith(ERROR_PREFIX))
        return { kind: 'error', message: text.slice(ERROR_PREFIX.length).trim() };
    return { kind: 'valid', text };
}
/** An empty `text` writes the empty sentinel: nothing here to summarise, do not ask again. */
export function writeSummary(summaryPath, text) {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    const trimmed = text.trim();
    fs.writeFileSync(summaryPath, trimmed === '' ? '' : `${trimmed}\n`, 'utf8');
}
/** Retried on the next sync; the reason is kept so a person can see why. */
export function writeErrorSentinel(summaryPath, error) {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    const message = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(summaryPath, `${ERROR_PREFIX} ${message.split('\n')[0]}\n`, 'utf8');
}
/** Quiet for long enough, not yet summarised (or the last try failed), newest
 * first, at most `limit`. */
export function selectForSummary(candidates, { now = Date.now(), quietMs = QUIET_MS, limit = DEFAULT_SUMMARY_LIMIT } = {}) {
    if (limit <= 0)
        return [];
    return candidates
        .filter((c) => c.sourceMtimeMs <= now - quietMs)
        .filter((c) => {
        const state = readSummaryState(summaryPathFor(c.archivePath)).kind;
        return state === 'missing' || state === 'error';
    })
        .sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs)
        .slice(0, limit);
}
/** The conversation as plain text for a model that cannot resume the session.
 * Over `maxChars`, keep the opening and the ending: how it started and how it
 * ended is what a summary needs most. */
export function transcriptText(exchanges, maxChars = 24_000) {
    const full = exchanges.map((e) => `User: ${e.userMessage}\nAssistant: ${e.assistantMessage}`).join('\n\n');
    if (full.length <= maxChars)
        return full;
    const half = Math.floor(maxChars / 2);
    return `${full.slice(0, half)}\n[…]\n${full.slice(full.length - half)}`;
}
/** Asks for the summary inside <summary></summary>. A resumed session tends to
 * treat a bare instruction as one more turn of the conversation and answer in
 * character ("I'm ready to help. What next?"); the tags are how we tell a
 * summary from chatter, see extractSummary. */
export const SUMMARY_PROMPT = 'Stop working on the task. Write a summary of this whole conversation for someone deciding whether to open it: ' +
    'two or three sentences, third person, plain language, saying what problem the user was working on and what was concluded or built. ' +
    'No preamble, no bullet points, no questions back. Output only the summary, wrapped exactly like this: <summary>...</summary>';
/** The text inside the first <summary> block, or undefined when there is none.
 * Callers decide what "none" means: the resume path treats it as a failed
 * attempt, the plain-text path accepts the raw reply. */
export function extractSummary(reply) {
    const m = reply.match(/<summary>([\s\S]*?)<\/summary>/i);
    const text = m?.[1].trim();
    return text ? text : undefined;
}
/** What the search result shows: a valid summary short enough to sit above the
 * snippet. Rows from before the archive point at the source file, so look the
 * summary up through the archive layout, not the stored path. */
export function summaryFor(exchange, archiveRoot) {
    const copy = archivePathFor(archiveRoot, exchange.harness ?? 'claude', exchange.project, exchange.archivePath);
    const state = readSummaryState(summaryPathFor(copy));
    if (state.kind !== 'valid' || state.text.length >= SUMMARY_DISPLAY_MAX_CHARS)
        return undefined;
    return state.text;
}
/** The `cwd` Claude Code recorded, from the first lines of the transcript. The
 * Agent SDK finds a session to resume under ~/.claude/projects/<encoded cwd>/. */
async function recordedCwd(archivePath) {
    const rl = readline.createInterface({ input: openArchive(archivePath), crlfDelay: Infinity });
    let seen = 0;
    let found;
    for await (const line of rl) {
        if (++seen > 50)
            break;
        try {
            const cwd = JSON.parse(line).cwd;
            if (typeof cwd === 'string' && cwd) {
                found = cwd;
                break;
            }
        }
        catch {
            // not JSON
        }
    }
    rl.close();
    return found;
}
function defaultSummarizers() {
    // Dynamic imports keep the Agent SDK out of the MCP server's start-up path;
    // only sync ever summarises.
    return {
        claude: async (input) => (await import('./summarizer-claude.js')).summarizeWithClaude(input),
        codex: async (input) => (await import('./summarizer-codex.js')).summarizeWithCodex(input),
    };
}
export async function summarizeQuietConversations(candidates, opts = {}) {
    const summarizers = opts.summarizers ?? defaultSummarizers();
    const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    const picked = selectForSummary(candidates, { now: opts.now, quietMs: opts.quietMs, limit: opts.limit });
    const result = { attempted: picked.length, written: 0, failed: 0 };
    for (const c of picked) {
        const summaryPath = summaryPathFor(c.archivePath);
        try {
            const exchanges = await parseConversation(c.archivePath, c.project, c.archivePath);
            if (exchanges.length === 0) {
                writeSummary(summaryPath, '');
                result.written++;
                continue;
            }
            const transcript = transcriptText(exchanges);
            const text = c.harness === 'codex'
                ? await summarizers.codex({ threadId: c.sessionId, transcript })
                : await summarizers.claude({ sessionId: c.sessionId, cwd: await recordedCwd(c.archivePath), transcript });
            writeSummary(summaryPath, text);
            result.written++;
        }
        catch (error) {
            writeErrorSentinel(summaryPath, error);
            result.failed++;
            log(`starmemory: summary failed for ${c.archivePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return result;
}
