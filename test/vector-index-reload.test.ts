// The MCP server opens the vector index once and then lives for a whole
// session, while the SessionStart sync (another process) rebuilds the file
// whenever it indexes something. Before this file existed, the server either
// crashed (the file was rewritten under its mmap) or kept answering from a
// graph that no longer knew about the new exchanges.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, type StoreHandle } from '../src/store.js';
import { EMBEDDING_DIM } from '../src/embeddings.js';
import { VectorIndex, versionedVectorIndexPath } from '../src/vector-index.js';
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

// The addon generation is part of the file name, as it is for the text index
// directory, so a build with a different on-disk layout never opens our file
// and we never open its.
describe('where the index file lives', () => {
  it('is the given path with the addon generation spliced in before the extension', () => {
    const version = addon().vectorIndexVersion();
    expect(versionedVectorIndexPath('/cfg/starmemory/index.hnsw')).toBe(`/cfg/starmemory/index-v${version}.hnsw`);
  });

  it('is written at the versioned path, never the bare one', () => {
    insertAlong(0);

    VectorIndex.open(store, base);

    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(versionedVectorIndexPath(base))).toBe(true);
  });

  it('removes the unversioned file an older build left behind', () => {
    fs.writeFileSync(base, 'an index from before the versioned path');
    insertAlong(0);

    VectorIndex.open(store, base);

    expect(fs.existsSync(base)).toBe(false);
  });

  it("prunes another generation's file once it has sat untouched for a month, and no sooner", () => {
    insertAlong(0);
    const stale = path.join(dir, 'index-v1.hnsw');
    const fresh = path.join(dir, 'index-v999.hnsw');
    const unrelated = path.join(dir, 'other-v1.hnsw');
    for (const f of [stale, fresh, unrelated]) fs.writeFileSync(f, 'some index');
    ageTo(stale, 40 * DAY_MS);
    ageTo(unrelated, 40 * DAY_MS);

    VectorIndex.open(store, base);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('reopens an existing file instead of rebuilding it', () => {
    insertAlong(0);
    VectorIndex.open(store, base);
    const file = versionedVectorIndexPath(base);
    ageTo(file, 5 * DAY_MS);
    const before = fs.statSync(file).mtimeMs;

    VectorIndex.open(store, base);

    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

describe('a long-lived reader while another handle rebuilds the index', () => {
  it('serves the rebuilt graph after refresh()', () => {
    const firstId = insertAlong(0);
    const reader = VectorIndex.open(store, base);
    expect(reader.size()).toBe(1);
    // Only one vector exists, so it is the nearest even to an orthogonal query.
    expect(reader.search(axis(1), 1).map((h) => h.id)).toEqual([firstId]);

    // The sync process: new rows, then a wholesale rebuild of the same path.
    const newId = insertAlong(1);
    VectorIndex.open(store, base).rebuild(store);
    reader.refresh();

    expect(reader.size()).toBe(2);
    expect(reader.search(axis(1), 1).map((h) => h.id)).toEqual([newId]);
  });

  it('does not reopen while the file is untouched', () => {
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

  it('gives up on a replacement it cannot open instead of retrying every call', () => {
    insertAlong(0);
    const reader = VectorIndex.open(store, base);
    const file = versionedVectorIndexPath(base);
    // Renamed in, not written in place: the reader's own mapping must stay intact.
    const garbage = path.join(dir, 'garbage');
    fs.writeFileSync(garbage, 'not an index');
    fs.renameSync(garbage, file);
    // Every failed reopen is reported, so one line for three calls means one try.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    reader.refresh();
    expect(reader.size()).toBe(1);
    expect(reader.search(axis(0), 1).length).toBe(1);
    reader.refresh();
    reader.refresh();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0][0])).toContain(file);
  });
});

describe('a closed native searcher', () => {
  it('refuses further use rather than touching freed memory', () => {
    insertAlong(0);
    VectorIndex.open(store, base);
    const searcher = addon().VectorSearcher.open(
      { dim: EMBEDDING_DIM, connectivity: 16, expansionAdd: 40, expansionSearch: 64 },
      versionedVectorIndexPath(base)
    );
    expect(searcher.len()).toBe(1);

    searcher.close();

    expect(() => searcher.len()).toThrow(/closed/);
    expect(() => searcher.search(axis(0), 1, null)).toThrow(/closed/);
    expect(() => searcher.close()).not.toThrow();
  });
});
