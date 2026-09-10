// Design doc archive-and-summaries §13: a conversation quiet for longer than
// the TTL leaves the memory whole: rows, vector, text documents, archive copy,
// summary. Age is last activity, not when it was archived.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, exchangesFrom, getVector, filterIds, type StoreHandle } from '../src/store.js';
import { TextIndex } from '../src/text-index.js';
import { EMBEDDING_DIM } from '../src/embeddings.js';
import { archivePathFor, summaryPathFor } from '../src/archive.js';
import { writeSummary } from '../src/summaries.js';
import { defaultTtlDays, expireOldConversations } from '../src/ttl.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-09T12:00:00Z');
let dir: string;
let store: StoreHandle;
let archiveRoot: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-ttl-'));
  store = openStore(path.join(dir, 'store.mdb'));
  archiveRoot = path.join(dir, 'archive');
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function vec(i: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

/** A conversation with `turns` exchanges whose archive copy was last written `ageDays` ago. */
function conversation(name: string, ageDays: number, turns = 2, opts: { withCopy?: boolean; harness?: 'claude' | 'codex' } = {}) {
  const harness = opts.harness ?? 'claude';
  const copy = archivePathFor(archiveRoot, harness, 'proj', `/src/proj/${name}.jsonl`);
  const ids: number[] = [];
  for (let t = 0; t < turns; t++) {
    ids.push(insertExchange(store, {
      harness, project: 'proj', sessionId: name,
      timestamp: new Date(now - ageDays * DAY + t * 1000).toISOString(),
      userMessage: `${name} question ${t} about lantern maintenance`, assistantMessage: `${name} answer ${t}`,
      archivePath: opts.withCopy === false ? `/src/proj/${name}.jsonl` : copy,
      lineStart: t * 2 + 1, lineEnd: t * 2 + 2, embeddingVersion: 1,
    }, vec(ids.length + 1)));
  }
  if (opts.withCopy !== false) {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'gz bytes');
    const then = new Date(now - ageDays * DAY);
    fs.utimesSync(copy, then, then);
    writeSummary(summaryPathFor(copy), `${name} summary`);
  }
  return { ids, copy, summary: summaryPathFor(copy) };
}

function textIndexWith(ids: number[]): TextIndex {
  const index = TextIndex.open(path.join(dir, 'text'));
  expect(index.tryAcquireWriter()).toBe(true);
  index.addExchanges(exchangesFrom(store, 0).filter((e) => ids.includes(e.id)));
  index.commit();
  return index;
}

describe('the TTL setting', () => {
  it('defaults to 180 days, reads the env, and treats 0 or nonsense as off', () => {
    expect(defaultTtlDays({})).toBe(180);
    expect(defaultTtlDays({ STARMEMORY_TTL_DAYS: '30' })).toBe(30);
    expect(defaultTtlDays({ STARMEMORY_TTL_DAYS: '0' })).toBe(0);
    expect(defaultTtlDays({ STARMEMORY_TTL_DAYS: 'soon' })).toBe(0);
  });
});

describe('expireOldConversations', () => {
  it('removes an expired conversation everywhere and leaves a live one untouched', () => {
    const old = conversation('old', 200);
    const fresh = conversation('fresh', 10);
    const text = textIndexWith([...old.ids, ...fresh.ids]);

    const result = expireOldConversations(store, text, { ttlDays: 180, now, archiveRoot });

    expect(result).toEqual({ rows: 2, files: 1, skipped: false });
    expect(exchangesFrom(store, 0).map((e) => e.id)).toEqual(fresh.ids);
    for (const id of old.ids) expect(getVector(store, id, EMBEDDING_DIM)).toBeUndefined();
    expect(filterIds(store, { sessionId: 'old' })).toEqual([]);
    expect(text.search('lantern', 10).map((h) => h.id).sort()).toEqual([...fresh.ids].sort());
    expect(fs.existsSync(old.copy)).toBe(false);
    expect(fs.existsSync(old.summary)).toBe(false);
    expect(fs.existsSync(fresh.copy)).toBe(true);
    expect(fs.existsSync(fresh.summary)).toBe(true);
  });

  it('judges age by the last activity, so an old conversation that was written to recently stays', () => {
    const c = conversation('revived', 200);
    const recently = new Date(now - 5 * DAY);
    fs.utimesSync(c.copy, recently, recently);

    const result = expireOldConversations(store, undefined, { ttlDays: 180, now, archiveRoot });

    expect(result.rows).toBe(0);
    expect(exchangesFrom(store, 0).length).toBe(2);
  });

  it('falls back to the exchange timestamps for rows whose source and copy are both gone', () => {
    conversation('legacy-old', 200, 2, { withCopy: false });
    const kept = conversation('legacy-fresh', 20, 2, { withCopy: false });

    const result = expireOldConversations(store, undefined, { ttlDays: 180, now, archiveRoot });

    expect(result.rows).toBe(2);
    expect(exchangesFrom(store, 0).map((e) => e.id)).toEqual(kept.ids);
  });

  it('does nothing when the TTL is off', () => {
    conversation('old', 400);
    expect(expireOldConversations(store, undefined, { ttlDays: 0, now, archiveRoot })).toEqual({ rows: 0, files: 0, skipped: false });
    expect(exchangesFrom(store, 0).length).toBe(2);
  });

  it('skips the whole run when another process holds the text writer', () => {
    const old = conversation('old', 200);
    const holder = textIndexWith(old.ids); // keeps the writer lock for the rest of the test
    const mine = TextIndex.open(path.join(dir, 'text'));

    const blocked = expireOldConversations(store, mine, { ttlDays: 180, now, archiveRoot });

    expect(blocked).toEqual({ rows: 0, files: 0, skipped: true });
    expect(exchangesFrom(store, 0).length).toBe(2);
    expect(fs.existsSync(old.copy)).toBe(true);
    expect(holder.numDocs()).toBe(2);
  });

  it('uses the Codex conversation project and harness to find its files', () => {
    const c = conversation('rollout-1', 200, 1, { harness: 'codex' });
    expect(c.copy).toContain(path.join('archive', 'codex', 'proj'));

    expireOldConversations(store, undefined, { ttlDays: 180, now, archiveRoot });

    expect(fs.existsSync(c.copy)).toBe(false);
  });
});
