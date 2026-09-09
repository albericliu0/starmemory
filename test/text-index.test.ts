// The TypeScript side of the Tantivy addon -- design doc §08. Runs against the
// real compiled addon, not a mock: the point of this layer is the conversion
// between our record shape and the native one, which a mock would not exercise.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextIndex, documentForExchange } from '../src/text-index.js';
import type { ConversationExchange } from '../src/types.js';

let dir: string;

function exchange(overrides: Partial<ConversationExchange> = {}): ConversationExchange {
  return {
    id: 1,
    project: 'proj-a',
    sessionId: 'sess-1',
    timestamp: '2026-03-01T10:00:00.000Z',
    userMessage: 'why did the compaction stall',
    assistantMessage: 'because the thread pool was saturated',
    archivePath: '/tmp/fake.jsonl',
    lineStart: 1,
    lineEnd: 2,
    embeddingVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-text-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writableIndex(): TextIndex {
  const index = TextIndex.open(path.join(dir, 'text'));
  expect(index.tryAcquireWriter()).toBe(true);
  return index;
}

describe('documentForExchange', () => {
  it('indexes both sides of the exchange, so an answer is findable too', () => {
    const doc = documentForExchange(exchange());

    expect(doc.text).toContain('why did the compaction stall');
    expect(doc.text).toContain('because the thread pool was saturated');
  });

  it('converts the ISO timestamp to epoch milliseconds', () => {
    const doc = documentForExchange(exchange({ timestamp: '2026-03-01T10:00:00.000Z' }));

    expect(doc.timestampMs).toBe(Date.parse('2026-03-01T10:00:00.000Z'));
  });

  it('marks a subagent turn so the engine can exclude it', () => {
    expect(documentForExchange(exchange({ isSidechain: true })).isSidechain).toBe(true);
    expect(documentForExchange(exchange()).isSidechain).toBe(false);
  });

  it('substitutes an empty session id rather than dropping the field', () => {
    const doc = documentForExchange(exchange({ sessionId: undefined }));

    expect(doc.sessionId).toBe('');
  });
});

describe('TextIndex', () => {
  it('creates the index directory it is given', () => {
    const target = path.join(dir, 'nested', 'text');

    TextIndex.open(target);

    expect(fs.existsSync(target)).toBe(true);
  });

  it('reports the schema version the addon was built with', () => {
    expect(TextIndex.open(path.join(dir, 'text')).version).toBeGreaterThan(0);
  });

  it('finds an exchange by a word from the assistant answer', () => {
    const index = writableIndex();
    index.addExchanges([exchange({ id: 7 })]);
    index.commit();

    expect(index.search('saturated', 10).map((h) => h.id)).toEqual([7]);
  });

  it('finds a Chinese exchange whose wording differs from the query', () => {
    const index = writableIndex();
    index.addExchanges([
      exchange({ id: 1, userMessage: '排查了很久', assistantMessage: '最后发现是内存的泄漏问题' }),
      exchange({ id: 2, userMessage: '磁盘满了怎么办', assistantMessage: '清理旧的日志文件' }),
    ]);
    index.commit();

    expect(index.search('内存泄漏', 10).map((h) => h.id)).toEqual([1]);
  });

  it('never returns a subagent turn', () => {
    const index = writableIndex();
    index.addExchanges([
      exchange({ id: 1, isSidechain: true }),
      exchange({ id: 2, isSidechain: false }),
    ]);
    index.commit();

    expect(index.search('compaction', 10).map((h) => h.id)).toEqual([2]);
  });

  it('applies a project filter', () => {
    const index = writableIndex();
    index.addExchanges([
      exchange({ id: 1, project: 'proj-a' }),
      exchange({ id: 2, project: 'proj-b' }),
    ]);
    index.commit();

    expect(index.search('compaction', 10, { project: 'proj-b' }).map((h) => h.id)).toEqual([2]);
  });

  it('applies a harness filter, so "only what I did in Codex" works on the text path too', () => {
    const index = writableIndex();
    index.addExchanges([
      exchange({ id: 1, harness: 'claude' }),
      exchange({ id: 2, harness: 'codex' }),
    ]);
    index.commit();

    expect(index.search('compaction', 10, { harness: 'codex' }).map((h) => h.id)).toEqual([2]);
  });

  it('indexes an untagged exchange as claude, matching the store', () => {
    const index = writableIndex();
    index.addExchanges([exchange({ id: 1, harness: undefined })]);
    index.commit();

    expect(index.search('compaction', 10, { harness: 'claude' }).map((h) => h.id)).toEqual([1]);
  });

  it('applies an ISO date range filter', () => {
    const index = writableIndex();
    index.addExchanges([
      exchange({ id: 1, timestamp: '2026-01-01T00:00:00.000Z' }),
      exchange({ id: 2, timestamp: '2026-06-01T00:00:00.000Z' }),
    ]);
    index.commit();

    const hits = index.search('compaction', 10, { after: '2026-03-01T00:00:00.000Z' });

    expect(hits.map((h) => h.id)).toEqual([2]);
  });

  it('counts the documents it holds', () => {
    const index = writableIndex();
    index.addExchanges([exchange({ id: 1 }), exchange({ id: 2 })]);
    index.commit();

    expect(index.numDocs()).toBe(2);
  });

  it('empties itself on deleteAll, so a rebuild does not duplicate documents', () => {
    const index = writableIndex();
    index.addExchanges([exchange({ id: 1 })]);
    index.commit();

    index.deleteAll();
    index.addExchanges([exchange({ id: 1 })]);
    index.commit();

    expect(index.numDocs()).toBe(1);
  });

  it('refuses a second writer while the first still holds the lock', () => {
    const first = writableIndex();
    expect(first.tryAcquireWriter()).toBe(true);

    const second = TextIndex.open(path.join(dir, 'text'));

    expect(second.tryAcquireWriter()).toBe(false);
  });

  it('lets a reader search an index another handle wrote', () => {
    const writer = writableIndex();
    writer.addExchanges([exchange({ id: 5 })]);
    writer.commit();

    const reader = TextIndex.open(path.join(dir, 'text'));

    expect(reader.search('saturated', 10).map((h) => h.id)).toEqual([5]);
  });
});
