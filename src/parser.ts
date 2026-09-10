// Parses transcripts into exchanges. Two formats, told apart per file:
//   - Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl, one message per line
//   - Codex: ~/.codex/sessions/**/rollout-*.jsonl, session_meta + response_item lines
// Ported from episodic-memory's src/parser.ts, trimmed to the fields this engine
// actually persists -- see design doc §07 "read 完整对话" for why raw-file reading
// stays untouched regardless of storage engine, and §16 for the two harnesses.
import fs from 'node:fs';
import { openArchive } from './archive.js';
import path from 'node:path';
import readline from 'node:readline';
import type { Harness, ParsedExchange } from './types.js';

interface JSONLMessage {
  type: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: string;
  isSidechain?: boolean;
  sessionId?: string;
  gitBranch?: string;
  /** Claude Code stamps how a user-role entry got there. `typed` and `queued`
   * mean a person wrote it; anything else means Claude Code injected it. */
  promptSource?: string;
  /** Set on entries Claude Code writes for its own bookkeeping. */
  isMeta?: boolean;
  /** The recap Claude Code writes after a compaction, as a user-role entry. */
  isCompactSummary?: boolean;
}

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

export function isInjectedUserTurn(
  entry: { promptSource?: string; isMeta?: boolean },
  text: string
): boolean {
  if (entry.promptSource !== undefined) {
    return !HUMAN_PROMPT_SOURCES.includes(entry.promptSource);
  }
  if (entry.isMeta) return true;
  return INJECTED_MARKERS.some((marker) => text.includes(marker));
}

function innerText(text: string, tag: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of text.matchAll(pattern)) {
    const inner = match[1].trim();
    if (inner) found.push(inner);
  }
  return found;
}

/** The part of an injected block worth indexing. Returns '' when there is none,
 * which is the honest answer for a system reminder: it is an instruction to the
 * model, not something anyone would search for. */
export function payloadOfInjectedTurn(text: string): string {
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
  if (stdout) return stdout;

  return '';
}

interface ExchangeBuilder {
  userMessage: string;
  userIsInjected: boolean;
  userLine: number;
  assistantMessages: string[];
  lastAssistantLine: number;
  timestamp: string;
  isSidechain?: boolean;
  sessionId?: string;
  gitBranch?: string;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n');
}

/** The line types only a Codex rollout has. A Claude Code transcript line has
 * `type: "user" | "assistant" | ...` and a `message`, never a `payload`. */
const CODEX_LINE_TYPES = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted']);

/** Reads the first parseable line and decides which format the file is in.
 * Unknown or empty files are read as Claude, the format that existed first. */
export async function detectHarness(filePath: string): Promise<Harness> {
  const rl = readline.createInterface({ input: openArchive(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; payload?: unknown };
        return parsed.payload && parsed.type && CODEX_LINE_TYPES.has(parsed.type) ? 'codex' : 'claude';
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
  }
  return 'claude';
}

export async function parseConversation(
  filePath: string,
  project: string,
  archivePath: string
): Promise<ParsedExchange[]> {
  if ((await detectHarness(filePath)) === 'codex') {
    return parseCodexConversation(filePath, project, archivePath);
  }
  return parseClaudeConversation(filePath, project, archivePath);
}

interface CodexRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: 'user' | 'assistant';
    content?: unknown;
    id?: string;
    cwd?: string;
    git?: { branch?: string };
  };
}

/** Codex message content is a list of typed blocks (`input_text`, `output_text`).
 * Anything carrying a `text` string counts; the block type names have changed
 * across Codex releases and none of them is worth filtering on. */
function codexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

/** Codex rollouts. The project is the basename of the session's `cwd`, which is
 * the closest thing to Claude Code's per-project folder; the caller's guess
 * from the file path is only the fallback. Tool calls and reasoning blocks are
 * skipped: they are not what a person would search for. */
async function parseCodexConversation(
  filePath: string,
  fallbackProject: string,
  archivePath: string
): Promise<ParsedExchange[]> {
  const exchanges: ParsedExchange[] = [];
  const rl = readline.createInterface({ input: openArchive(filePath), crlfDelay: Infinity });

  let lineNumber = 0;
  let project = fallbackProject;
  let sessionId: string | undefined;
  let gitBranch: string | undefined;
  let current: ExchangeBuilder | null = null;

  const finalize = () => {
    if (current && current.assistantMessages.length > 0) {
      exchanges.push({
        harness: 'codex',
        project,
        sessionId,
        gitBranch,
        timestamp: current.timestamp,
        userMessage: current.userMessage,
        userIsInjected: false,
        assistantMessage: current.assistantMessages.join('\n\n'),
        archivePath,
        lineStart: current.userLine,
        lineEnd: current.lastAssistantLine,
      });
    }
    current = null;
  };

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    let parsed: CodexRolloutLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = parsed.payload;
    if (!payload) continue;

    if (parsed.type === 'session_meta' || parsed.type === 'turn_context') {
      if (payload.cwd) project = path.basename(payload.cwd) || project;
      if (parsed.type === 'session_meta') {
        sessionId = payload.id ?? sessionId;
        gitBranch = payload.git?.branch ?? gitBranch;
      }
      continue;
    }
    if (parsed.type !== 'response_item' || payload.type !== 'message') continue;

    const text = codexText(payload.content);
    if (!text.trim()) continue;
    const timestamp = parsed.timestamp ?? new Date().toISOString();

    if (payload.role === 'user') {
      finalize();
      current = {
        userMessage: text,
        userIsInjected: false,
        userLine: lineNumber,
        assistantMessages: [],
        lastAssistantLine: lineNumber,
        timestamp,
      };
    } else if (payload.role === 'assistant' && current) {
      current.assistantMessages.push(text);
      current.lastAssistantLine = lineNumber;
      current.timestamp = timestamp;
    }
  }

  finalize();
  return exchanges;
}

async function parseClaudeConversation(
  filePath: string,
  project: string,
  archivePath: string
): Promise<ParsedExchange[]> {
  const exchanges: ParsedExchange[] = [];
  const rl = readline.createInterface({
    input: openArchive(filePath),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let current: ExchangeBuilder | null = null;

  const finalize = () => {
    if (current && current.assistantMessages.length > 0) {
      exchanges.push({
        harness: 'claude',
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
    if (!line.trim()) continue;

    let parsed: JSONLMessage;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed line, skip
    }

    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
    if (!parsed.message) continue;
    // Claude's own compaction recap sits in a user-role entry. It is not what
    // the person said, and it repeats turns that are already in the file.
    if (parsed.isCompactSummary) continue;

    const text = extractText(parsed.message.content);
    if (!text.trim()) continue;

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
    } else if (parsed.message.role === 'assistant' && current) {
      current.assistantMessages.push(text);
      current.lastAssistantLine = lineNumber;
      if (parsed.timestamp) current.timestamp = parsed.timestamp;
    }
  }

  finalize();
  return exchanges;
}

/** Derives a project name the same way episodic-memory does: the JSONL file's
 * parent directory name (Claude Code's sanitized-cwd slug). */
export function projectFromPath(filePath: string): string {
  // path.basename(path.dirname()) rather than a split on '/', so a Windows
  // path yields its parent directory too.
  const parent = path.basename(path.dirname(filePath));
  return parent && parent !== '.' && parent !== path.sep ? parent : 'unknown';
}
