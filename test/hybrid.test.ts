// Hybrid retrieval end to end -- design doc §06.
// Real embeddings, real HNSW graph, real Tantivy index. The claim being tested
// is the one from §01: a Chinese query that neither path can answer alone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, type StoreHandle } from '../src/store.js';
import { generateExchangeEmbedding, initEmbeddings } from '../src/embeddings.js';
import { VectorIndex } from '../src/vector-index.js';
import { TextIndex } from '../src/text-index.js';
import { syncTextIndex } from '../src/sync.js';
import { search } from '../src/search.js';

let store: StoreHandle;
let vectors: VectorIndex;
let text: TextIndex;
let dir: string;

const FIXTURES: { project: string; user: string; assistant: string; harness?: 'claude' | 'codex' }[] = [
  {
    project: 'starrocks',
    harness: 'codex',
    user: 'How does StarRocks handle colocate join?',
    assistant: 'Colocate join places co-located tablets on the same BE to avoid network shuffle.',
  },
  {
    project: 'starrocks',
    user: 'the compaction has failed on this tablet',
    assistant: 'Check whether the cumulative rowset count exceeded the configured limit.',
  },
  {
    project: 'recall-engine',
    user: '这次线上问题排查了很久',
    assistant: '最后定位到是内存的泄漏，连接池创建之后一直没有关闭',
  },
  {
    project: 'recall-engine',
    user: '磁盘写满了应该怎么处理',
    assistant: '先清理过期的日志文件，再调整保留策略',
  },
  {
    project: 'unrelated',
    user: 'What is the capital of France?',
    assistant: 'Paris is the capital of France.',
  },
  {
    // What an injected turn looks like once the parser has normalised it away:
    // nothing on the user side, real content on the assistant side.
    project: 'starrocks',
    user: '',
    assistant: 'the review found a lock ordering inversion in compaction_manager.cpp',
  },
];

beforeAll(async () => {
  await initEmbeddings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-hybrid-'));
  store = openStore(path.join(dir, 'store.mdb'));

  for (const f of FIXTURES) {
    const embedding = await generateExchangeEmbedding(f.user, f.assistant);
    insertExchange(
      store,
      {
        project: f.project,
        harness: f.harness,
        sessionId: 's1',
        timestamp: '2026-03-01T10:00:00.000Z',
        userMessage: f.user,
        assistantMessage: f.assistant,
        archivePath: '/tmp/fake.jsonl',
        lineStart: 1,
        lineEnd: 2,
        embeddingVersion: 1,
      },
      embedding
    );
  }

  vectors = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
  text = TextIndex.open(path.join(dir, 'text'));
  syncTextIndex(store, text);
}, 120_000);

afterAll(async () => {
  vectors.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const CHINESE_LEAK = '最后定位到是内存的泄漏';

describe('the case this change exists for', () => {
  it('finds a Chinese exchange whose wording differs from the query', async () => {
    // The embedding model is English-only and the text is 内存的泄漏 while the
    // query is 内存泄漏, so neither the old vector path nor a substring scan works.
    const results = await search(store, vectors, '内存泄漏', { limit: 3 }, text);

    expect(results[0].exchange.assistantMessage).toContain(CHINESE_LEAK);
    // Insist that BM25 is what found it. Without this the test could pass on a
    // lucky ordering from the English-only embedding model.
    expect(results[0].textRank).toBe(1);
  });

  it('cannot find it by substring scan, which is why BM25 was added', async () => {
    const substring = await search(store, vectors, '内存泄漏', { mode: 'text', limit: 3 });

    expect(substring).toEqual([]);
  });
});

describe('BM25 ranking', () => {
  it('matches an English phrase whose word form differs from the text', async () => {
    const results = await search(store, vectors, 'compaction failed', { mode: 'text', limit: 3 }, text);

    expect(results[0].exchange.userMessage).toContain('compaction has failed');
  });

  it('ranks by relevance rather than by scan order', async () => {
    const results = await search(store, vectors, 'colocate join tablets', { mode: 'text', limit: 5 }, text);

    expect(results[0].exchange.project).toBe('starrocks');
    expect(results[0].exchange.userMessage).toContain('colocate join');
  });
});

describe('hybrid mode', () => {
  it('reports the rank each path gave a result', async () => {
    const results = await search(store, vectors, 'compaction failed', { limit: 5 }, text);
    const fromBoth = results.find((r) => r.vectorRank !== undefined && r.textRank !== undefined);

    expect(fromBoth).toBeDefined();
    expect(fromBoth!.score).toBeGreaterThan(0);
  });

  it('covers results that only one path found', async () => {
    const vectorOnly = await search(store, vectors, '内存泄漏', { mode: 'vector', limit: 5 });
    const hybrid = await search(store, vectors, '内存泄漏', { limit: 5 }, text);

    const hybridIds = hybrid.map((r) => r.exchange.id);
    expect(hybridIds).toContain(vectorOnly[0].exchange.id);
    expect(hybrid.some((r) => r.exchange.assistantMessage.includes(CHINESE_LEAK))).toBe(true);
  });

  it('returns no duplicates', async () => {
    const results = await search(store, vectors, 'compaction', { limit: 10 }, text);
    const ids = results.map((r) => r.exchange.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honours the limit', async () => {
    const results = await search(store, vectors, 'the', { limit: 2 }, text);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('applies the project filter to both paths', async () => {
    const results = await search(store, vectors, 'compaction join', { limit: 10, project: 'starrocks' }, text);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.exchange.project).toBe('starrocks');
  });

  it('applies the harness filter to both paths, so "only what I did in Codex" works', async () => {
    const results = await search(store, vectors, 'compaction join', { limit: 10, harness: 'codex' }, text);

    expect(results.map((r) => r.exchange.userMessage)).toEqual(['How does StarRocks handle colocate join?']);
  });

  it('reads fixtures inserted without a harness as claude', async () => {
    const results = await search(store, vectors, 'compaction join', { limit: 10, harness: 'claude' }, text);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.exchange.userMessage).not.toBe('How does StarRocks handle colocate join?');
  });

  it('treats the old "both" mode as an alias so the MCP surface does not change', async () => {
    const hybrid = await search(store, vectors, 'compaction', { mode: 'hybrid', limit: 5 }, text);
    const both = await search(store, vectors, 'compaction', { mode: 'both', limit: 5 }, text);

    expect(both.map((r) => r.exchange.id)).toEqual(hybrid.map((r) => r.exchange.id));
  });
});

describe('exchanges whose user side was injected away', () => {
  it('shows the assistant text in the snippet, instead of an empty line', async () => {
    const results = await search(store, vectors, 'lock ordering inversion', { limit: 5 }, text);
    const injected = results.find((r) => r.exchange.userMessage === '');

    expect(injected).toBeDefined();
    expect(injected!.snippet).toContain('compaction_manager.cpp');
  });
});
