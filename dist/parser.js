// Parses Claude Code's JSONL transcript format (~/.claude/projects/<slug>/<uuid>.jsonl)
// into exchanges. Ported from episodic-memory's src/parser.ts, trimmed to
// Claude-only (no Codex) and to the fields this engine actually persists --
// see design doc §07 "read 完整对话" for why raw-file reading stays untouched
// regardless of storage engine.
import fs from 'node:fs';
import readline from 'node:readline';
/** How a person's own message is marked. This is a whitelist on purpose: a
 * blacklist of markers is always one Claude Code release behind, and some
 * injected kinds (slash-command echoes) carry no structural flag at all. */
const HUMAN_PROMPT_SOURCES = ['typed', 'queued'];
/** Only consulted for entries that carry no `promptSource` at all, which is how
 * older transcripts look. */
const INJECTED_MARKERS = [
    '<task-notification>',
    '<command-name>',
    '<local-command',
    '<system-reminder>',
];
/** Tags inside a task notification that hold something a person would search for.
 * `result` is the big one: it carries the subagent's actual report, which is
 * often the most valuable text in the whole record, and `summary` says which
 * task it was. Everything else is identifiers, temp paths, token counts, or
 * `note`, which is the same fixed sentence on every notification explaining to
 * the model what a notification is. */
const NOTIFICATION_CONTENT_TAGS = ['summary', 'result'];
export function isInjectedUserTurn(entry, text) {
    if (entry.promptSource !== undefined) {
        return !HUMAN_PROMPT_SOURCES.includes(entry.promptSource);
    }
    if (entry.isMeta)
        return true;
    return INJECTED_MARKERS.some((marker) => text.includes(marker));
}
function innerText(text, tag) {
    const found = [];
    const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    for (const match of text.matchAll(pattern)) {
        const inner = match[1].trim();
        if (inner)
            found.push(inner);
    }
    return found;
}
/** The part of an injected block worth indexing. Returns '' when there is none,
 * which is the honest answer for a system reminder: it is an instruction to the
 * model, not something anyone would search for. */
export function payloadOfInjectedTurn(text) {
    if (text.includes('<task-notification>')) {
        // Strip the wrapper first, or its lazy closing tag swallows every inner tag.
        const body = text
            .replace(/^[\s\S]*?<task-notification>/, '')
            .replace(/<\/task-notification>[\s\S]*$/, '');
        return NOTIFICATION_CONTENT_TAGS.flatMap((tag) => innerText(body, tag)).join('\n\n');
    }
    const [command] = innerText(text, 'command-name');
    if (command) {
        const [args] = innerText(text, 'command-args');
        return args ? `${command} ${args}` : command;
    }
    const [stdout] = innerText(text, 'local-command-stdout');
    if (stdout)
        return stdout;
    return '';
}
function extractText(content) {
    if (typeof content === 'string')
        return content;
    return content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n');
}
export async function parseConversation(filePath, project, archivePath) {
    const exchanges = [];
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
    });
    let lineNumber = 0;
    let current = null;
    const finalize = () => {
        if (current && current.assistantMessages.length > 0) {
            exchanges.push({
                project,
                sessionId: current.sessionId,
                gitBranch: current.gitBranch,
                timestamp: current.timestamp,
                userMessage: current.userMessage,
                userIsInjected: current.userIsInjected,
                assistantMessage: current.assistantMessages.join('\n\n'),
                archivePath,
                lineStart: current.userLine,
                lineEnd: current.lastAssistantLine,
                isSidechain: current.isSidechain,
            });
        }
    };
    for await (const line of rl) {
        lineNumber++;
        if (!line.trim())
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue; // malformed line, skip
        }
        if (parsed.type !== 'user' && parsed.type !== 'assistant')
            continue;
        if (!parsed.message)
            continue;
        const text = extractText(parsed.message.content);
        if (!text.trim())
            continue;
        if (parsed.message.role === 'user') {
            finalize();
            const injected = isInjectedUserTurn(parsed, text);
            current = {
                // An injected block is kept only as its meaningful payload. Storing the
                // raw text would claim the user said something they never typed, and it
                // is what made search snippets unreadable.
                userMessage: injected ? payloadOfInjectedTurn(text) : text,
                userIsInjected: injected,
                userLine: lineNumber,
                assistantMessages: [],
                lastAssistantLine: lineNumber,
                timestamp: parsed.timestamp ?? new Date().toISOString(),
                isSidechain: parsed.isSidechain,
                sessionId: parsed.sessionId,
                gitBranch: parsed.gitBranch,
            };
        }
        else if (parsed.message.role === 'assistant' && current) {
            current.assistantMessages.push(text);
            current.lastAssistantLine = lineNumber;
            if (parsed.timestamp)
                current.timestamp = parsed.timestamp;
        }
    }
    finalize();
    return exchanges;
}
/** Derives a project name the same way episodic-memory does: the JSONL file's
 * parent directory name (Claude Code's sanitized-cwd slug). */
export function projectFromPath(filePath) {
    const parts = filePath.split('/');
    return parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
}
