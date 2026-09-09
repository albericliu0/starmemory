// The MCP server opens the vector index once and then lives for a whole
// session, while the SessionStart sync (another process) rebuilds it whenever
// it indexes something. A rebuild writes the next generation file and records
// the number in LMDB meta; the reader switches when it sees the number change.
// Nothing is ever renamed over or written into a file a reader may have
// mapped, which is what lets the same code run on Windows (design doc
// windows-support §07).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, type StoreHandle } from '../src/store.js';
import { EMBEDDING_DIM } from '../src/embeddings.js';
import {
  VectorIndex,
  VECTOR_GENERATION_KEY,
  currentGeneration,
  generationPath,
  versionedVectorIndexPath,
} from '../src/vector-index.js';
import { addon } from '../src/addon.js';

let dir: string;
let store: StoreHandle;
let base: string;

/** A unit vector pointing along one axis, so results are unambiguous. */
function axis(i: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[i] = 1;
  return v;
}

function insertAlong(i: number): number {
  return insertExchange(
    store,
    {
      project: 'p',
      sessionId: 's',
      timestamp: '2026-03-01T10:00:00.000Z',
      userMessage: `question ${i}`,
      assistantMessage: `answer ${i}`,
      archivePath: '/tmp/fake.jsonl',
      lineStart: i,
      lineEnd: i + 1,
      embeddingVersion: 1,
    },
    axis(i)
  );
}

function searcherOf(index: VectorIndex): { close(): void } {
  return (index as unknown as { searcher: { close(): void } }).searcher;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ageTo(file: string, ageMs: number): void {
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
}

const g = (n: number) => generationPath(base, n);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-reload-'));
  store = openStore(path.join(dir, 'store.mdb'));
  base = path.join(dir, 'index.hnsw');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('where the index file lives', () => {
  it('carries the addon version and a generation number', () => {
    const version = addon().vectorIndexVersion();
    expect(generationPath('/cfg/starmemory/index.hnsw', 3)).toBe(`/cfg/starmemory/index-v${version}.g3.hnsw`);
    expect(versionedVectorIndexPath('/cfg/starmemory/index.hnsw')).toBe(`/cfg/starmemory/index-v${version}.hnsw`);
  });

  it('starts at generation 0 and records it in the store', () => {
    insertAlong(0);

    VectorIndex.open(store, base);

    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(g(0))).toBe(true);
    expect(currentGeneration(store)).toBe(0);
  });

  it('moves to the next generation on rebuild and drops the old file', () => {
    insertAlong(0);
    const index = VectorIndex.open(store, base);

    insertAlong(1);
    index.rebuild(store);

    expect(currentGeneration(store)).toBe(1);
    expect(fs.existsSync(g(1))).toBe(true);
    expect(fs.existsSync(g(0))).toBe(false);
    expect(index.currentPath).toBe(g(1));
  });

  it('adopts a pre-generation file as generation 0 instead of rebuilding it', () => {
    insertAlong(0);
    VectorIndex.open(store, base);
    // Turn the clock back: a store from before generations has the versioned
    // file and no generation key.
    fs.renameSync(g(0), versionedVectorIndexPath(base));
    store.meta.remove(VECTOR_GENERATION_KEY);
    const before = fs.statSync(versionedVectorIndexPath(base)).mtimeMs;
    ageTo(versionedVectorIndexPath(base), 5 * DAY_MS);
    const aged = fs.statSync(versionedVectorIndexPath(base)).mtimeMs;
    expect(aged).not.toBe(before);

    const index = VectorIndex.open(store, base);

    expect(currentGeneration(store)).toBe(0);
    expect(fs.existsSync(versionedVectorIndexPath(base))).toBe(false);
    expect(fs.statSync(g(0)).mtimeMs).toBe(aged);
    expect(index.size()).toBe(1);
  });

  it('removes the unversioned file an older build left behind', () => {
    fs.writeFileSync(base, 'an index from before the versioned path');
    insertAlong(0);

    VectorIndex.open(store, base);

    expect(fs.existsSync(base)).toBe(false);
  });

  it("prunes another version's files once they have sat untouched for a month, and never its own", () => {
    insertAlong(0);
    const version = addon().vectorIndexVersion();
    const staleOther = path.join(dir, 'index-v1.g4.hnsw');
    const staleOtherLegacy = path.join(dir, 'index-v1.hnsw');
    const freshOther = path.join(dir, 'index-v999.g0.hnsw');
    const unrelated = path.join(dir, 'other-v1.hnsw');
    for (const f of [staleOther, staleOtherLegacy, freshOther, unrelated]) fs.writeFileSync(f, 'some index');
    for (const f of [staleOther, staleOtherLegacy, unrelated]) ageTo(f, 40 * DAY_MS);

    VectorIndex.open(store, base);

    expect(fs.existsSync(staleOther)).toBe(false);
    expect(fs.existsSync(staleOtherLegacy)).toBe(false);
    expect(fs.existsSync(freshOther)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(path.join(dir, `index-v${version}.g0.hnsw`))).toBe(true);
  });

  it('reopens an existing generation instead of rebuilding it', () => {
    insertAlong(0);
    VectorIndex.open(store, base);
    ageTo(g(0), 5 * DAY_MS);
    const before = fs.statSync(g(0)).mtimeMs;

    VectorIndex.open(store, base);

    expect(fs.statSync(g(0)).mtimeMs).toBe(before);
    expect(currentGeneration(store)).toBe(0);
  });
});

describe('a long-lived reader while another handle rebuilds the index', () => {
  it('serves the rebuilt graph after refresh()', () => {
    const firstId = insertAlong(0);
    const reader = VectorIndex.open(store, base);
    expect(reader.size()).toBe(1);
    // Only one vector exists, so it is the nearest even to an orthogonal query.
    expect(reader.search(axis(1), 1).map((h) => h.id)).toEqual([firstId]);

    // The sync process: new rows, then a rebuild into the next generation.
    const newId = insertAlong(1);
    VectorIndex.open(store, base).rebuild(store);
    reader.refresh();

    expect(reader.size()).toBe(2);
    expect(reader.search(axis(1), 1).map((h) => h.id)).toEqual([newId]);
    expect(reader.currentPath).toBe(g(1));
  });

  it('does not reopen while the store still names its generation', () => {
    insertAlong(0);
    const reader = VectorIndex.open(store, base);
    const closeSpy = vi.spyOn(searcherOf(reader), 'close');

    reader.refresh();
    reader.refresh();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(reader.size()).toBe(1);
  });

  it('releases the graph it opened first once it has switched to the new one', () => {
    insertAlong(0);
    const reader = VectorIndex.open(store, base);
    const closeSpy = vi.spyOn(searcherOf(reader), 'close');

    VectorIndex.open(store, base).rebuild(store);
    reader.refresh();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps answering from its own file while the writer is still on the next one', () => {
    // The old generation is only swept by the writer after it has switched;
    // until then, and on Windows for as long as we map it, our file is intact.
    insertAlong(0);
    const reader = VectorIndex.open(store, base);
    const writer = VectorIndex.open(store, base);
    insertAlong(1);

    writer.rebuild(store);

    // Not refreshed yet: still generation 0, still one vector.
    expect(reader.currentPath).toBe(g(0));
    expect(reader.size()).toBe(1);
  });

  it('gives up on a generation it cannot open instead of retrying every call', () => {
    insertAlong(0);
    const reader = VectorIndex.open(store, base);
    // A writer that produced garbage and still advanced the pointer.
    fs.writeFileSync(g(1), 'not an index');
    store.meta.putSync(VECTOR_GENERATION_KEY, '1');
    // Every failed reopen is reported, so one line for three calls means one try.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    reader.refresh();
    expect(reader.size()).toBe(1);
    expect(reader.search(axis(0), 1).length).toBe(1);
    reader.refresh();
    reader.refresh();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0][0])).toContain('generation 1');
    expect(reader.currentPath).toBe(g(0));
  });
});

describe('a closed native searcher', () => {
  it('refuses further use rather than touching freed memory', () => {
    insertAlong(0);
    VectorIndex.open(store, base);
    const searcher = addon().VectorSearcher.open(
      { dim: EMBEDDING_DIM, connectivity: 16, expansionAdd: 40, expansionSearch: 64 },
      g(0)
    );
    expect(searcher.len()).toBe(1);

    searcher.close();

    expect(() => searcher.len()).toThrow(/closed/);
    expect(() => searcher.search(axis(0), 1, null)).toThrow(/closed/);
    expect(() => searcher.close()).not.toThrow();
  });
});
