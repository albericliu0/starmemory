// Design doc archive-and-summaries §04-§06: after indexing, sync summarises a
// bounded number of quiet conversations, each through the harness it came from,
// and a failure becomes a sentinel that is retried next time.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type StoreHandle } from '../src/store.js';
import { VectorIndex } from '../src/vector-index.js';
import { initEmbeddings } from '../src/embeddings.js';
import { syncAll } from '../src/sync.js';

const HOUR = 60 * 60 * 1000;
let dir: string;
let store: StoreHandle;
let archiveRoot: string;

function ageTo(file: string, ageMs: number): void {
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
}

function transcript(project: string, name: string, lines: number): string {
  const projectDir = path.join(dir, 'transcripts', project);
  fs.mkdirSync(projectDir, { recursive: true });
  const entries: string[] = [];
  for (let i = 0; i < lines; i++) {
    entries.push(JSON.stringify({ type: 'user', promptSource: 'typed', sessionId: name, cwd: '/Users/me/proj',
      timestamp: `2026-03-01T10:0${i}:00.000Z`, message: { role: 'user', content: `question ${i}` } }));
    entries.push(JSON.stringify({ type: 'assistant', timestamp: `2026-03-01T10:0${i}:30.000Z`,
      message: { role: 'assistant', content: `answer ${i}` } }));
  }
  const file = path.join(projectDir, `${name}.jsonl`);
  fs.writeFileSync(file, entries.join('\n'));
  return file;
}

function codexTranscript(name: string, threadId: string): string {
  const sessionsDir = path.join(dir, 'codex-sessions', '2026', '05', '12');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const entries = [
    { timestamp: '2026-05-12T18:00:00.000Z', type: 'session_meta', payload: { id: threadId, cwd: '/Users/me/code/example-project', originator: 'codex_cli_rs', cli_version: '0.130.0' } },
    { timestamp: '2026-05-12T18:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'where is config loaded?' }] } },
    { timestamp: '2026-05-12T18:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'In src/config.ts.' }] } },
  ];
  const file = path.join(sessionsDir, `${name}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

beforeAll(async () => {
  await initEmbeddings();
}, 300_000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-sync-summaries-'));
  store = openStore(path.join(dir, 'store.mdb'));
  archiveRoot = path.join(dir, 'archive');
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const summaryFile = (harness: string, project: string, name: string) => path.join(archiveRoot, harness, project, `${name}-summary.txt`);

describe('the summary step', () => {
  it('summarises quiet conversations through the harness they came from and leaves busy ones alone', async () => {
    ageTo(transcript('-Users-me-proj', 'quiet', 2), 3 * HOUR);
    transcript('-Users-me-proj', 'busy', 2);
    ageTo(codexTranscript('rollout-1', 'thread-9'), 3 * HOUR);
    const seen: string[] = [];
    const summarizers = {
      claude: async (i: { sessionId?: string; cwd?: string }) => { seen.push(`claude:${i.sessionId}:${i.cwd}`); return 'Claude said.'; },
      codex: async (i: { threadId?: string }) => { seen.push(`codex:${i.threadId}`); return 'Codex said.'; },
    };
    const index = VectorIndex.open(store, path.join(dir, 'index.hnsw'));

    const result = await syncAll(store, index, [path.join(dir, 'transcripts'), path.join(dir, 'codex-sessions')], undefined, { archiveRoot, summaries: { summarizers } });

    expect(result.summarized).toBe(2);
    expect(result.summaryFailed).toBe(0);
    expect(seen.sort()).toEqual(['claude:quiet:/Users/me/proj', 'codex:thread-9']);
    expect(fs.readFileSync(summaryFile('claude', '-Users-me-proj', 'quiet'), 'utf8')).toBe('Claude said.\n');
    expect(fs.readFileSync(summaryFile('codex', 'example-project', 'rollout-1'), 'utf8')).toBe('Codex said.\n');
    expect(fs.existsSync(summaryFile('claude', '-Users-me-proj', 'busy'))).toBe(false);
  }, 120_000);

  it('writes an error sentinel when the summarizer throws and retries it next time', async () => {
    ageTo(transcript('-Users-me-proj', 'flaky', 1), 3 * HOUR);
    const index = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    let calls = 0;
    const summarizers = {
      claude: async () => { calls++; if (calls === 1) throw new Error('not logged in'); return 'Second time lucky.'; },
      codex: async () => '',
    };
    const lines: string[] = [];
    const opts = { archiveRoot, summaries: { summarizers, log: (l: string) => lines.push(l) } };

    const first = await syncAll(store, index, path.join(dir, 'transcripts'), undefined, opts);
    expect(first.summaryFailed).toBe(1);
    expect(first.summarized).toBe(0);
    const sentinel = summaryFile('claude', '-Users-me-proj', 'flaky');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('[error] not logged in\n');
    expect(lines.join('\n')).toContain('not logged in');

    const second = await syncAll(store, index, path.join(dir, 'transcripts'), undefined, opts);
    expect(second.summarized).toBe(1);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('Second time lucky.\n');
  }, 120_000);

  it('respects the per-run limit and takes the newest first', async () => {
    for (let i = 0; i < 4; i++) ageTo(transcript('-Users-me-proj', `c${i}`, 1), (3 + i) * HOUR);
    const index = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    const seen: string[] = [];
    const summarizers = { claude: async (i: { sessionId?: string }) => { seen.push(i.sessionId!); return 's'; }, codex: async () => '' };

    await syncAll(store, index, path.join(dir, 'transcripts'), undefined, { archiveRoot, summaries: { summarizers, limit: 2 } });

    expect(seen).toEqual(['c0', 'c1']);
  }, 120_000);

  it('does nothing when the limit is zero', async () => {
    ageTo(transcript('-Users-me-proj', 'q', 1), 3 * HOUR);
    const index = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    const summarizers = { claude: async () => 'never', codex: async () => 'never' };

    const result = await syncAll(store, index, path.join(dir, 'transcripts'), undefined, { archiveRoot, summaries: { summarizers, limit: 0 } });

    expect(result.summarized).toBe(0);
    expect(fs.existsSync(summaryFile('claude', '-Users-me-proj', 'q'))).toBe(false);
  }, 120_000);

  it('writes the empty sentinel for a conversation with nothing to summarise', async () => {
    const projectDir = path.join(dir, 'transcripts', '-Users-me-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, 'empty.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'x' }) + '\n');
    ageTo(file, 3 * HOUR);
    const index = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    const summarizers = { claude: async () => 'never', codex: async () => 'never' };

    const result = await syncAll(store, index, path.join(dir, 'transcripts'), undefined, { archiveRoot, summaries: { summarizers } });

    expect(result.summarized).toBe(1);
    expect(fs.readFileSync(summaryFile('claude', '-Users-me-proj', 'empty'), 'utf8')).toBe('');
  }, 120_000);
});
