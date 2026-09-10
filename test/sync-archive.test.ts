// Design doc archive-and-summaries §03: sync copies each transcript into the
// archive before reading it, and the rows point at the copy. The per-file
// cursor stays keyed by the source path, so nothing is indexed twice.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, exchangesFrom, type StoreHandle } from '../src/store.js';
import { VectorIndex } from '../src/vector-index.js';
import { initEmbeddings } from '../src/embeddings.js';
import { syncAll } from '../src/sync.js';
import { readArchive } from '../src/archive.js';

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

function transcript(project: string, name: string, lines: number): string {
  const projectDir = path.join(dir, 'transcripts', project);
  fs.mkdirSync(projectDir, { recursive: true });
  const entries: string[] = [];
  for (let i = 0; i < lines; i++) {
    entries.push(JSON.stringify({ type: 'user', promptSource: 'typed', sessionId: name,
      timestamp: `2026-03-01T10:0${i}:00.000Z`, message: { role: 'user', content: `question ${i}` } }));
    entries.push(JSON.stringify({ type: 'assistant', timestamp: `2026-03-01T10:0${i}:30.000Z`,
      message: { role: 'assistant', content: `answer ${i}` } }));
  }
  const file = path.join(projectDir, `${name}.jsonl`);
  fs.writeFileSync(file, entries.join('\n'));
  return file;
}

beforeAll(async () => {
  await initEmbeddings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-sync-archive-'));
  store = openStore(path.join(dir, 'store.mdb'));
}, 300_000);

afterAll(async () => {
  for (const i of openedIndexes.splice(0)) i.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('syncAll with an archive', () => {
  it('copies each transcript and points the rows at the copy', async () => {
    const source = transcript('-Users-me-proj', 's1', 2);
    const archiveRoot = path.join(dir, 'archive');
    const index = openIndex(store, path.join(dir, 'index.hnsw'));

    const result = await syncAll(store, index, path.join(dir, 'transcripts'), undefined, { archiveRoot });

    const copy = path.join(archiveRoot, 'claude', '-Users-me-proj', 's1.jsonl.gz');
    expect(result.archived).toBe(1);
    expect(readArchive(copy)).toBe(fs.readFileSync(source, 'utf8'));
    const rows = exchangesFrom(store, 0);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.archivePath).toBe(copy);
  }, 120_000);

  it('does not copy or index again when nothing changed, and picks up new lines when the source grows', async () => {
    const archiveRoot = path.join(dir, 'archive');
    const index = openIndex(store, path.join(dir, 'index.hnsw'));
    const transcripts = path.join(dir, 'transcripts');

    const unchanged = await syncAll(store, index, transcripts, undefined, { archiveRoot });
    expect(unchanged.archived).toBe(0);
    expect(unchanged.exchangesIndexed).toBe(0);

    const grownFile = transcript('-Users-me-proj', 's1', 3);
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(grownFile, later, later);
    const grown = await syncAll(store, index, transcripts, undefined, { archiveRoot });
    expect(grown.archived).toBe(1);
    expect(grown.exchangesIndexed).toBe(1);
    expect(exchangesFrom(store, 0).length).toBe(3);
  }, 120_000);
});
