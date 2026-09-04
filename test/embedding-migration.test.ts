// Switching embedding models must not leave a store half in one model and half
// in another: every stored vector is compared against every query, so they all
// have to come from the same model. Design doc (recall engine) §08 specified
// "meta 里存 embedding_model_version，不匹配则触发批量重嵌入"; this is that.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, getVector, exchangesFrom, type StoreHandle } from '../src/store.js';
import { EMBEDDING_DIM, EMBEDDING_MODEL, initEmbeddings } from '../src/embeddings.js';
import { ensureEmbeddingModel, EMBEDDING_MODEL_KEY } from '../src/sync.js';
import { VectorIndex } from '../src/vector-index.js';

let store: StoreHandle;
let dir: string;

const OLD_DIM = 384;

function insertWithStaleVector(id: number, isSidechain = false) {
  // What a store written by the previous model looks like: 384-dim vectors.
  return insertExchange(
    store,
    {
      project: 'p',
      sessionId: 's',
      timestamp: '2026-03-01T10:00:00.000Z',
      userMessage: `question ${id}`,
      assistantMessage: `answer ${id}`,
      archivePath: '/tmp/fake.jsonl',
      lineStart: id,
      lineEnd: id + 1,
      embeddingVersion: 1,
      isSidechain,
    },
    isSidechain ? null : new Float32Array(OLD_DIM).fill(0.1)
  );
}

beforeAll(async () => {
  await initEmbeddings();
}, 300_000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-migrate-'));
  store = openStore(path.join(dir, 'store.mdb'));
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureEmbeddingModel', () => {
  it('re-embeds every exchange when the store was written by a different model', async () => {
    const a = insertWithStaleVector(1);
    const b = insertWithStaleVector(2);
    store.meta.putSync(EMBEDDING_MODEL_KEY, 'Xenova/bge-small-en-v1.5');

    const result = await ensureEmbeddingModel(store);

    expect(result.reembedded).toBe(2);
    expect(getVector(store, a, EMBEDDING_DIM)!.length).toBe(EMBEDDING_DIM);
    expect(getVector(store, b, EMBEDDING_DIM)!.length).toBe(EMBEDDING_DIM);
  });

  it('treats a store with no recorded model as needing migration', async () => {
    insertWithStaleVector(1);

    const result = await ensureEmbeddingModel(store);

    expect(result.reembedded).toBe(1);
  });

  it('records the current model once it is done', async () => {
    insertWithStaleVector(1);

    await ensureEmbeddingModel(store);

    expect(store.meta.get(EMBEDDING_MODEL_KEY)).toBe(EMBEDDING_MODEL);
  });

  it('does nothing when the recorded model already matches', async () => {
    insertWithStaleVector(1);
    store.meta.putSync(EMBEDDING_MODEL_KEY, EMBEDDING_MODEL);

    const result = await ensureEmbeddingModel(store);

    expect(result.reembedded).toBe(0);
  });

  it('gives subagent turns no vector, same as a fresh insert', async () => {
    const side = insertWithStaleVector(1, true);
    insertWithStaleVector(2);

    await ensureEmbeddingModel(store);

    expect(getVector(store, side, EMBEDDING_DIM)).toBeUndefined();
    expect(exchangesFrom(store, 0).length).toBe(2);
  });
});

describe('a stale store before migration', () => {
  it('yields no vectors of the wrong size, so the index cannot be built from garbage', () => {
    insertWithStaleVector(1);

    const index = VectorIndex.open(store, path.join(dir, 'index.usearch'));

    expect(index.size()).toBe(0);
  });
});

describe('syncAll', () => {
  it('reports how many vectors it re-embedded, so a silent 30-second migration is visible', async () => {
    insertWithStaleVector(1);
    insertWithStaleVector(2);
    const { syncAll } = await import('../src/sync.js');
    const emptyTranscripts = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-no-transcripts-'));

    const result = await syncAll(store, VectorIndex.open(store, path.join(dir, 'index.usearch')), emptyTranscripts);

    expect(result.reembedded).toBe(2);
    fs.rmSync(emptyTranscripts, { recursive: true, force: true });
  });
});

describe('vector index version', () => {
  it('rebuilds the index file when the recorded version differs from the addon', async () => {
    const { VECTOR_INDEX_VERSION_KEY } = await import('../src/vector-index.js');
    insertWithStaleVector(1);
    await ensureEmbeddingModel(store);
    const indexPath = path.join(dir, 'index.usearch');
    VectorIndex.open(store, indexPath);
    const built = fs.statSync(indexPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    store.meta.putSync(VECTOR_INDEX_VERSION_KEY, 0);
    VectorIndex.open(store, indexPath);

    expect(fs.statSync(indexPath).mtimeMs).toBeGreaterThan(built);
    expect(store.meta.get(VECTOR_INDEX_VERSION_KEY)).toBeGreaterThan(0);
  });

  it('keeps the index file when the recorded version matches', async () => {
    insertWithStaleVector(1);
    await ensureEmbeddingModel(store);
    const indexPath = path.join(dir, 'index.usearch');
    VectorIndex.open(store, indexPath);
    const built = fs.statSync(indexPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    VectorIndex.open(store, indexPath);

    expect(fs.statSync(indexPath).mtimeMs).toBe(built);
  });
});
