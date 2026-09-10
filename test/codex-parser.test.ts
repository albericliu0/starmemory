// Codex writes its transcripts as "rollout" JSONL under ~/.codex/sessions: one
// session_meta line, turn_context lines, then response_item lines whose payload
// carries the actual messages. Same store, different loading dock (design doc
// §16). The parser has to tell the two formats apart per file, because both
// harnesses' directories are scanned by the same sync.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversation, detectHarness } from '../src/parser.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-codex-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function jsonl(name: string, entries: Record<string, unknown>[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const SESSION_META = {
  timestamp: '2026-05-12T18:00:00.000Z',
  type: 'session_meta',
  payload: {
    id: '019e4c75-d5bf-7c71-9df7-77f5fb86b711',
    cwd: '/Users/me/code/example-project',
    originator: 'codex_cli_rs',
    cli_version: '0.130.0',
    model_provider: 'openai',
    git: { branch: 'codex-support' },
  },
};

const codexUser = (text: string, ts = '2026-05-12T18:00:02.000Z') => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

const codexAssistant = (text: string, ts = '2026-05-12T18:00:06.000Z') => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});

function codexRollout(): Record<string, unknown>[] {
  return [
    SESSION_META,
    {
      timestamp: '2026-05-12T18:00:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/Users/me/code/example-project', model: 'gpt-5.2' },
    },
    codexUser('Please inspect the config loader.'),
    {
      timestamp: '2026-05-12T18:00:03.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
    },
    {
      timestamp: '2026-05-12T18:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"sed -n 1,80p src/config.ts"}', call_id: 'c1' },
    },
    {
      timestamp: '2026-05-12T18:00:05.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'export function loadConfig() {}' },
    },
    codexAssistant('The config loader currently reads the default profile first.'),
  ];
}

describe('detectHarness', () => {
  it('recognises a Codex rollout by its session_meta line', async () => {
    expect(await detectHarness(jsonl('rollout.jsonl', codexRollout()))).toBe('codex');
  });

  it('treats a Claude Code transcript as claude', async () => {
    const file = jsonl('claude.jsonl', [
      { type: 'user', promptSource: 'typed', message: { role: 'user', content: 'hi' }, timestamp: '2026-03-01T10:00:00.000Z' },
    ]);
    expect(await detectHarness(file)).toBe('claude');
  });
});

describe('parseConversation on a Codex rollout', () => {
  it('yields one exchange per user turn, stamped as codex', async () => {
    const file = jsonl('rollout.jsonl', codexRollout());
    const exchanges = await parseConversation(file, 'from-path', file);

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].harness).toBe('codex');
    expect(exchanges[0].userMessage).toBe('Please inspect the config loader.');
    expect(exchanges[0].assistantMessage).toBe('The config loader currently reads the default profile first.');
  });

  it('takes project, session and branch from session_meta, not from the file path', async () => {
    const file = jsonl('rollout.jsonl', codexRollout());
    const [exchange] = await parseConversation(file, 'from-path', file);

    expect(exchange.project).toBe('example-project');
    expect(exchange.sessionId).toBe('019e4c75-d5bf-7c71-9df7-77f5fb86b711');
    expect(exchange.gitBranch).toBe('codex-support');
  });

  it('spans the exchange from the user line to the last assistant line', async () => {
    const file = jsonl('rollout.jsonl', codexRollout());
    const [exchange] = await parseConversation(file, 'from-path', file);

    expect(exchange.lineStart).toBe(3);
    expect(exchange.lineEnd).toBe(7);
    expect(exchange.timestamp).toBe('2026-05-12T18:00:06.000Z');
  });

  it('drops a user turn that never got an answer', async () => {
    const file = jsonl('rollout.jsonl', [
      SESSION_META,
      codexUser('first'),
      codexAssistant('answer to first'),
      codexUser('second, still unanswered', '2026-05-12T18:00:07.000Z'),
    ]);
    const exchanges = await parseConversation(file, 'p', file);

    expect(exchanges.map((e) => e.userMessage)).toEqual(['first']);
  });

  it('falls back to the caller-supplied project when session_meta has no cwd', async () => {
    const file = jsonl('rollout.jsonl', [
      { type: 'session_meta', timestamp: '2026-05-12T18:00:00.000Z', payload: { id: 'sess' } },
      codexUser('q'),
      codexAssistant('a'),
    ]);
    const [exchange] = await parseConversation(file, 'from-path', file);

    expect(exchange.project).toBe('from-path');
  });
});

describe('parseConversation on a Claude Code transcript', () => {
  it('stamps the exchange as claude', async () => {
    const file = jsonl('claude.jsonl', [
      { type: 'user', promptSource: 'typed', sessionId: 's1', message: { role: 'user', content: 'hi' }, timestamp: '2026-03-01T10:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: 'hello' }, timestamp: '2026-03-01T10:00:01.000Z' },
    ]);
    const [exchange] = await parseConversation(file, 'proj', file);

    expect(exchange.harness).toBe('claude');
  });
});
