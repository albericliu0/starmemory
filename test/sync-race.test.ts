// Two Claude Code sessions starting at once fire two SessionStart syncs against
// one store. Measured before the fix: 230 rows for 132 exchanges. The per-file
// cursor was read, then embeddings were awaited, then rows were inserted -- and
// both syncs read the same old cursor. This test races two syncAll calls in one
// process; the await on embeddings is exactly where they interleave.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, exchangesFrom, type StoreHandle } from '../src/store.js';
import { VectorIndex } from '../src/vector-index.js';
import { initEmbeddings } from '../src/embeddings.js';
import { syncAll } from '../src/sync.js';

/** Every VectorIndex opened here, closed in teardown: Windows cannot delete
 * a file that is still mapped, so a leaked handle fails the cleanup. */
const openedIndexes: VectorIndex[] = [];
function openIndex(s: StoreHandle, p: string): VectorIndex {
  const i = VectorIndex.open(s, p);
  openedIndexes.push(i);
  return i;
}


let dir: string;
let store: StoreHandle;

function transcript(lines: number): string {
  const projectDir = path.join(dir, 'transcripts', '-Users-me-proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const entries: string[] = [];
  for (let i = 0; i < lines; i++) {
    entries.push(JSON.stringify({ type: 'user', promptSource: 'typed', sessionId: 's1',
      timestamp: `2026-03-01T10:0${i}:00.000Z`, message: { role: 'user', content: `question number ${i}` } }));
    entries.push(JSON.stringify({ type: 'assistant', timestamp: `2026-03-01T10:0${i}:30.000Z`,
      message: { role: 'assistant', content: `answer number ${i}` } }));
  }
  fs.writeFileSync(path.join(projectDir, 'session.jsonl'), entries.join('\n'));
  return path.join(dir, 'transcripts');
}

beforeAll(async () => {
  await initEmbeddings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-race-'));
  store = openStore(path.join(dir, 'store.mdb'));
}, 300_000);

afterAll(async () => {
  for (const i of openedIndexes.splice(0)) i.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('two syncs racing on one fresh store', () => {
  it('store each exchange exactly once', async () => {
    const transcripts = transcript(4);
    const index = openIndex(store, path.join(dir, 'index.usearch'));

    await Promise.all([
      syncAll(store, index, transcripts, undefined, { archiveRoot: path.join(dir, 'archive') }),
      syncAll(store, index, transcripts, undefined, { archiveRoot: path.join(dir, 'archive') }),
    ]);

    const rows = exchangesFrom(store, 0);
    const distinct = new Set(rows.map((e) => `${e.archivePath}:${e.lineStart}`)).size;
    expect(distinct).toBe(4);
    expect(rows.length).toBe(distinct);
  }, 120_000);
});
