// Storage-layer behaviour that search depends on -- design doc §05/§07.
// Filters must be answerable from the secondary indexes, without parsing every
// exchange, because they run on the hot path of every query.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  insertExchange,
  filterIds,
  getVector,
  exchangesFrom,
  reindexHarness,
  type StoreHandle,
} from '../src/store.js';
import type { ConversationExchange } from '../src/types.js';

let store: StoreHandle;
let dir: string;

const DIM = 4;

function vector(): Float32Array {
  return Float32Array.from([1, 0, 0, 0]);
}

function insert(overrides: Partial<ConversationExchange> = {}): number {
  const base = {
    project: 'proj-a',
    sessionId: 'sess-1',
    timestamp: '2026-03-01T10:00:00.000Z',
    userMessage: 'question',
    assistantMessage: 'answer',
    archivePath: '/tmp/fake.jsonl',
    lineStart: 1,
    lineEnd: 2,
    embeddingVersion: 1,
    ...overrides,
  };
  return insertExchange(store, base, vector());
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-store-'));
  store = openStore(path.join(dir, 'store.mdb'));
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('filterIds', () => {
  it('returns undefined when no filter was asked for, meaning "no restriction"', () => {
    insert();

    expect(filterIds(store, {})).toBeUndefined();
  });

  it('narrows to one project', () => {
    const a = insert({ project: 'proj-a' });
    insert({ project: 'proj-b' });

    expect(filterIds(store, { project: 'proj-a' })).toEqual([a]);
  });

  it('narrows to one session', () => {
    const first = insert({ sessionId: 'sess-1' });
    insert({ sessionId: 'sess-2' });

    expect(filterIds(store, { sessionId: 'sess-1' })).toEqual([first]);
  });

  it('narrows by an inclusive ISO date range', () => {
    insert({ timestamp: '2026-01-01T00:00:00.000Z' });
    const middle = insert({ timestamp: '2026-03-01T00:00:00.000Z' });
    const late = insert({ timestamp: '2026-06-01T00:00:00.000Z' });

    const ids = filterIds(store, { after: '2026-03-01T00:00:00.000Z' })!;

    expect([...ids].sort((x, y) => x - y)).toEqual([middle, late]);
  });

  it('applies both ends of the range', () => {
    insert({ timestamp: '2026-01-01T00:00:00.000Z' });
    const middle = insert({ timestamp: '2026-03-01T00:00:00.000Z' });
    insert({ timestamp: '2026-06-01T00:00:00.000Z' });

    const ids = filterIds(store, {
      after: '2026-02-01T00:00:00.000Z',
      before: '2026-04-01T00:00:00.000Z',
    })!;

    expect(ids).toEqual([middle]);
  });

  it('intersects a project filter with a date range', () => {
    insert({ project: 'proj-a', timestamp: '2026-01-01T00:00:00.000Z' });
    const wanted = insert({ project: 'proj-a', timestamp: '2026-06-01T00:00:00.000Z' });
    insert({ project: 'proj-b', timestamp: '2026-06-01T00:00:00.000Z' });

    const ids = filterIds(store, { project: 'proj-a', after: '2026-03-01T00:00:00.000Z' })!;

    expect(ids).toEqual([wanted]);
  });

  it('returns an empty list, not undefined, when a filter matches nothing', () => {
    insert({ project: 'proj-a' });

    expect(filterIds(store, { project: 'nope' })).toEqual([]);
  });
});

describe('subagent turns', () => {
  it('stores no vector, so a subagent turn can never surface in vector search', () => {
    const id = insert({ isSidechain: true });

    expect(getVector(store, id, DIM)).toBeUndefined();
  });

  it('still stores the exchange itself, so reading a full conversation works', () => {
    const id = insert({ isSidechain: true });

    expect(exchangesFrom(store, 0).map((e) => e.id)).toContain(id);
  });

  it('keeps the vector for an ordinary turn', () => {
    const id = insert({ isSidechain: false });

    expect(getVector(store, id, DIM)).toBeDefined();
  });
});

// Both harnesses write into one store (design doc §16). The tag has to be
// answerable from a secondary index like project is, because "only what I did
// in Codex" is a filter on the hot path of a query.
describe('harness filter', () => {
  it('narrows to one harness', () => {
    const codex = insert({ harness: 'codex' });
    insert({ harness: 'claude' });

    expect(filterIds(store, { harness: 'codex' })).toEqual([codex]);
  });

  it('reads an exchange with no harness field as claude, the only harness that existed before', () => {
    const untagged = insert({ harness: undefined });

    expect(filterIds(store, { harness: 'claude' })).toEqual([untagged]);
  });

  it('intersects the harness filter with a project filter', () => {
    const match = insert({ harness: 'codex', project: 'proj-a' });
    insert({ harness: 'codex', project: 'proj-b' });
    insert({ harness: 'claude', project: 'proj-a' });

    expect(filterIds(store, { harness: 'codex', project: 'proj-a' })).toEqual([match]);
  });
});

describe('reindexHarness', () => {
  it('gives rows stored before the harness index existed an index entry', () => {
    // The native row shape lets a caller omit the harness entirely, which is how
    // every row written before this change looks in an existing store.
    const { ids } = store.native.insert(
      [{ json: JSON.stringify({ project: 'p', timestamp: 't', userMessage: 'q', assistantMessage: 'a', archivePath: '/f', lineStart: 1, lineEnd: 2, embeddingVersion: 1 }),
         project: 'p', timestamp: 't', lineEnd: 2, isSidechain: false }],
      null
    );
    expect(filterIds(store, { harness: 'claude' })).toEqual([]);

    const reindexed = reindexHarness(store);

    expect(reindexed).toBe(1);
    expect(filterIds(store, { harness: 'claude' })).toEqual(ids);
  });
});

describe('exchangesFrom', () => {
  it('yields every exchange from the given id onward, in id order', () => {
    const first = insert();
    const second = insert();
    const third = insert();

    expect(exchangesFrom(store, second).map((e) => e.id)).toEqual([second, third]);
    expect(exchangesFrom(store, first).map((e) => e.id)).toEqual([first, second, third]);
  });

  it('yields nothing when the cursor is past the last id', () => {
    const id = insert();

    expect(exchangesFrom(store, id + 1)).toEqual([]);
  });
});
