// Keeping the BM25 index in step with LMDB -- design doc §09/§10.
//
// The property that matters: a sync process that cannot take the writer lock
// must lose nothing. Its rows are already in LMDB, and whichever process holds
// the lock next has to pick them up.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, type StoreHandle } from '../src/store.js';
import { TextIndex } from '../src/text-index.js';
import { syncTextIndex, textCursorKey } from '../src/sync.js';

let store: StoreHandle;
let dir: string;

function insert(overrides: Record<string, unknown> = {}): number {
  return insertExchange(
    store,
    {
      project: 'proj-a',
      sessionId: 'sess-1',
      timestamp: '2026-03-01T10:00:00.000Z',
      userMessage: 'why did the compaction stall',
      assistantMessage: 'the thread pool was saturated',
      archivePath: '/tmp/fake.jsonl',
      lineStart: 1,
      lineEnd: 2,
      embeddingVersion: 1,
      ...overrides,
    } as never,
    null
  );
}

function openIndex(): TextIndex {
  return TextIndex.open(path.join(dir, 'text'));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-sync-'));
  store = openStore(path.join(dir, 'store.mdb'));
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('syncTextIndex', () => {
  it('indexes everything already in the store on the first run', () => {
    insert();
    insert();
    const index = openIndex();

    const result = syncTextIndex(store, index);

    expect(result.skipped).toBe(false);
    expect(result.indexed).toBe(2);
    expect(index.numDocs()).toBe(2);
  });

  it('adds only what is new on a second run', () => {
    insert();
    const index = openIndex();
    syncTextIndex(store, index);

    insert();
    const second = syncTextIndex(store, index);

    expect(second.indexed).toBe(1);
    expect(index.numDocs()).toBe(2);
  });

  it('does no work at all when the store has not changed', () => {
    insert();
    const index = openIndex();
    syncTextIndex(store, index);

    expect(syncTextIndex(store, index).indexed).toBe(0);
    expect(index.numDocs()).toBe(1);
  });

  it('leaves the cursor one past the last indexed id', () => {
    const first = insert();
    const second = insert();
    const index = openIndex();

    syncTextIndex(store, index);

    expect(second).toBe(first + 1);
    expect(store.meta.get(textCursorKey(index.version))).toBe(second + 1);
  });

  it('reports skipped when another process holds the writer lock', () => {
    insert();
    const holder = openIndex();
    expect(holder.tryAcquireWriter()).toBe(true);

    const result = syncTextIndex(store, openIndex());

    expect(result.skipped).toBe(true);
    expect(result.indexed).toBe(0);
  });

  it('does not move the cursor when it was skipped', () => {
    insert();
    const holder = openIndex();
    holder.tryAcquireWriter();

    syncTextIndex(store, openIndex());

    expect(store.meta.get(textCursorKey(holder.version))).toBeUndefined();
  });

  it('lets the next lock holder pick up the rows the skipped run wrote', () => {
    const holder = openIndex();
    holder.tryAcquireWriter();
    insert();
    insert();

    expect(syncTextIndex(store, openIndex()).skipped).toBe(true);
    const caughtUp = syncTextIndex(store, holder);

    expect(caughtUp.indexed).toBe(2);
    expect(holder.numDocs()).toBe(2);
  });

  it('stores the cursor under a key that names the schema version', () => {
    const first = insert();
    const index = openIndex();

    syncTextIndex(store, index);

    expect(store.meta.get(textCursorKey(index.version))).toBe(first + 1);
  });

  it('rebuilds when the index is empty but the cursor says rows were indexed', () => {
    // The directory was wiped (or is a fresh one for this schema) while LMDB
    // still remembers a cursor. The index is a cache over LMDB: reload it all.
    insert();
    syncTextIndex(store, openIndex());
    const fresh = TextIndex.open(path.join(dir, 'text-elsewhere'));

    const result = syncTextIndex(store, fresh);

    expect(result.rebuilt).toBe(true);
    expect(result.indexed).toBe(1);
    expect(fresh.numDocs()).toBe(1);
  });

  it('indexes subagent turns as well, so the index mirrors the store one for one', () => {
    insert({ isSidechain: true });
    insert({ isSidechain: false });
    const index = openIndex();

    syncTextIndex(store, index);

    expect(index.numDocs()).toBe(2);
    expect(index.search('compaction', 10).map((h) => h.id)).toEqual([1]);
  });
});
