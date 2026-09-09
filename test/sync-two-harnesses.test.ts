// One store, two loading docks (design doc §16): a sync started from either
// harness scans both ~/.claude/projects and ~/.codex/sessions, so a question
// asked in Codex yesterday is findable from Claude Code today and vice versa.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, exchangesFrom, filterIds, type StoreHandle } from '../src/store.js';
import { VectorIndex } from '../src/vector-index.js';
import { initEmbeddings } from '../src/embeddings.js';
import { syncAll, defaultTranscriptDirs } from '../src/sync.js';

let dir: string;
let store: StoreHandle;

function claudeDir(): string {
  const projectDir = path.join(dir, 'claude', '-Users-me-proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'session.jsonl'),
    [
      { type: 'user', promptSource: 'typed', sessionId: 'c1', timestamp: '2026-03-01T10:00:00.000Z', message: { role: 'user', content: 'asked in claude code' } },
      { type: 'assistant', timestamp: '2026-03-01T10:00:30.000Z', message: { role: 'assistant', content: 'answered in claude code' } },
    ].map((e) => JSON.stringify(e)).join('\n')
  );
  return path.join(dir, 'claude');
}

function codexDir(): string {
  const dayDir = path.join(dir, 'codex', '2026', '05', '12');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(
    path.join(dayDir, 'rollout-2026-05-12T18-00-00-019e4c75.jsonl'),
    [
      { timestamp: '2026-05-12T18:00:00.000Z', type: 'session_meta', payload: { id: 'x1', cwd: '/Users/me/proj', git: { branch: 'main' } } },
      { timestamp: '2026-05-12T18:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'asked in codex' }] } },
      { timestamp: '2026-05-12T18:00:06.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answered in codex' }] } },
    ].map((e) => JSON.stringify(e)).join('\n')
  );
  return path.join(dir, 'codex');
}

beforeAll(async () => {
  await initEmbeddings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-two-harness-'));
  store = openStore(path.join(dir, 'store.mdb'));
}, 300_000);

afterAll(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('syncAll over both harness directories', () => {
  it('stores exchanges from Claude Code and Codex in the same store, each tagged', async () => {
    const index = VectorIndex.open(store, path.join(dir, 'index.usearch'));

    const result = await syncAll(store, index, [claudeDir(), codexDir()]);

    expect(result.filesScanned).toBe(2);
    expect(result.exchangesIndexed).toBe(2);
    const rows = exchangesFrom(store, 0);
    expect(rows.map((r) => [r.harness, r.project, r.userMessage]).sort()).toEqual([
      ['claude', '-Users-me-proj', 'asked in claude code'],
      ['codex', 'proj', 'asked in codex'],
    ]);
  }, 120_000);

  it('skips a source directory that does not exist instead of failing', async () => {
    const index = VectorIndex.open(store, path.join(dir, 'index.usearch'));

    const result = await syncAll(store, index, [path.join(dir, 'nowhere')]);

    expect(result.filesScanned).toBe(0);
  });
});

describe('rows from before Codex support', () => {
  it('get a harness index entry on the first sync, so a claude filter still finds them', async () => {
    const oldStore = openStore(path.join(dir, 'old-store.mdb'));
    try {
      // How every row written before this change looks: no harness anywhere.
      oldStore.native.insert(
        [{ json: JSON.stringify({ project: 'p', timestamp: '2026-01-01T00:00:00.000Z', userMessage: 'old question', assistantMessage: 'old answer', archivePath: '/old.jsonl', lineStart: 1, lineEnd: 2, embeddingVersion: 1 }),
           project: 'p', timestamp: '2026-01-01T00:00:00.000Z', lineEnd: 2, isSidechain: false }],
        null
      );
      expect(filterIds(oldStore, { harness: 'claude' })).toEqual([]);

      await syncAll(oldStore, VectorIndex.open(oldStore, path.join(dir, 'old-index.usearch')), []);

      expect(filterIds(oldStore, { harness: 'claude' })).toEqual([0]);
    } finally {
      await oldStore.close();
    }
  }, 120_000);
});

describe('defaultTranscriptDirs', () => {
  it('lists the Claude Code projects dir and the Codex sessions dir', () => {
    const dirs = defaultTranscriptDirs({ HOME: '/Users/me' });

    expect(dirs).toEqual(['/Users/me/.claude/projects', '/Users/me/.codex/sessions']);
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME, the same overrides each harness uses', () => {
    const dirs = defaultTranscriptDirs({ HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/p/claude', CODEX_HOME: '/p/codex' });

    expect(dirs).toEqual(['/p/claude/projects', '/p/codex/sessions']);
  });
});
