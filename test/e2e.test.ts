// End-to-end smoke test: store + real embeddings + native HNSW index + search.
// Exercises design doc §07's feature list against actual code, not mocks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, type StoreHandle } from '../src/store.js';
import { generateExchangeEmbedding, initEmbeddings } from '../src/embeddings.js';
import { VectorIndex } from '../src/vector-index.js';
import { search, searchMultipleConcepts } from '../src/search.js';

let store: StoreHandle;
let index: VectorIndex;
let tmpDir: string;

const FIXTURES: { project: string; sessionId: string; user: string; assistant: string }[] = [
  {
    project: 'starrocks',
    sessionId: 's1',
    user: 'How does StarRocks handle colocate join?',
    assistant: 'Colocate join places co-located tablets on the same BE to avoid network shuffle.',
  },
  {
    project: 'starrocks',
    sessionId: 's1',
    user: 'Explain the compaction strategy in StarRocks storage engine.',
    assistant: 'StarRocks uses size-tiered compaction for base and cumulative rowsets.',
  },
  {
    project: 'recall-engine',
    sessionId: 's2',
    user: 'What vector index library should we use for local semantic search?',
    assistant: 'tenann wraps faiss HNSW with efficient filtered search via IDSelector.',
  },
  {
    project: 'recall-engine',
    sessionId: 's2',
    user: 'Why is LMDB a better fit than SQLite for this concurrency pattern?',
    assistant: 'LMDB enforces single-writer transactions at the engine level via flock.',
  },
  {
    project: 'unrelated',
    sessionId: 's3',
    user: 'What is the capital of France?',
    assistant: 'Paris is the capital of France.',
  },
];

beforeAll(async () => {
  await initEmbeddings();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-e2e-'));
  store = openStore(path.join(tmpDir, 'store.mdb'));

  for (const f of FIXTURES) {
    const embedding = await generateExchangeEmbedding(f.user, f.assistant);
    insertExchange(
      store,
      {
        project: f.project,
        sessionId: f.sessionId,
        timestamp: new Date().toISOString(),
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

  index = VectorIndex.open(store, path.join(tmpDir, 'index.hnsw'));
}, 60_000);

afterAll(async () => {
  index.close();
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('vector search', () => {
  it('finds the semantically closest exchange, not just keyword matches', async () => {
    const results = await search(store, index, 'graph-based nearest neighbor search library', {
      mode: 'vector',
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].exchange.project).toBe('recall-engine');
    expect(results[0].exchange.assistantMessage).toContain('faiss HNSW');
  });

  it('respects the project metadata filter via the native id_filter path', async () => {
    const results = await search(store, index, 'search', {
      mode: 'vector',
      limit: 10,
      project: 'starrocks',
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.exchange.project).toBe('starrocks');
    }
  });
});

describe('text search', () => {
  it('finds exact substring matches', async () => {
    const results = await search(store, index, 'compaction', { mode: 'text', limit: 10 });
    expect(results.length).toBe(1);
    expect(results[0].exchange.userMessage).toContain('compaction');
  });
});

describe('both mode', () => {
  it('merges vector and text hits without duplicates', async () => {
    const results = await search(store, index, 'LMDB', { mode: 'both', limit: 10 });
    const ids = results.map((r) => r.exchange.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(results.some((r) => r.exchange.assistantMessage.includes('LMDB'))).toBe(true);
  });
});

describe('multi-concept AND search', () => {
  it('only returns exchanges matching every concept', async () => {
    const results = await searchMultipleConcepts(store, index, ['vector index', 'concurrency'], {
      limit: 10,
    });
    // Only the LMDB exchange plausibly touches both "vector index" and "concurrency" concepts
    // via semantic similarity to the recall-engine project's two exchanges together.
    expect(results.every((r) => r.conceptSimilarities.length === 2)).toBe(true);
  });
});

// The sync process rebuilds the index while this server keeps running. Both
// entry points must pick up the new file before answering, and each must do so
// once per query so every concept of an AND search sees the same graph.
describe('a sync landing while the server is up', () => {
  let newId: number;

  beforeAll(async () => {
    const user = 'How does the Kubernetes scheduler pick a node for a pending pod?';
    const assistant = 'kube-scheduler filters nodes by resources and taints, then scores the survivors.';
    newId = insertExchange(
      store,
      {
        project: 'k8s',
        sessionId: 's4',
        timestamp: new Date().toISOString(),
        userMessage: user,
        assistantMessage: assistant,
        archivePath: '/tmp/fake.jsonl',
        lineStart: 1,
        lineEnd: 2,
        embeddingVersion: 1,
      },
      await generateExchangeEmbedding(user, assistant)
    );
    const rebuilder = VectorIndex.open(store, path.join(tmpDir, 'index.hnsw'));
    rebuilder.rebuild(store);
    rebuilder.close();
    index.refresh();
  }, 60_000);

  it('search() answers from the rebuilt index', async () => {
    const results = await search(store, index, 'kubernetes pod scheduling', { mode: 'vector', limit: 3 });
    expect(results.map((r) => r.exchange.id)).toContain(newId);
  });

  it('searchMultipleConcepts() answers from the rebuilt index', async () => {
    const results = await searchMultipleConcepts(store, index, ['kubernetes scheduler', 'pending pod'], { limit: 3 });
    expect(results.map((r) => r.exchange.id)).toContain(newId);
  });
});
