// The embedding model -- design doc §06, revised: multilingual.
// The old model was English-only, so a Chinese query against Chinese text was
// near-random on the vector path and BM25 had to carry it alone. These tests
// pin the two things the switch is for.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  generateEmbedding,
  generateQueryEmbedding,
  initEmbeddings,
} from '../src/embeddings.js';

const cos = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

beforeAll(async () => {
  await initEmbeddings();
}, 300_000);

describe('embedding model', () => {
  it('names the model and dimension it was built for, so a store can tell when they change', () => {
    expect(EMBEDDING_MODEL).toMatch(/jina-embeddings-v2-base-zh/);
    expect(EMBEDDING_DIM).toBe(768);
  });

  it('produces unit vectors of the declared dimension', async () => {
    const v = await generateEmbedding('hello');

    expect(v.length).toBe(EMBEDDING_DIM);
    expect(Math.sqrt(cos(v, v))).toBeCloseTo(1, 3);
  });

  it('places a Chinese query nearer its Chinese answer than an unrelated Chinese one', async () => {
    const q = await generateQueryEmbedding('内存泄漏怎么排查');
    const related = await generateEmbedding('最后定位到是内存的泄漏，连接池创建之后一直没有关闭');
    const unrelated = await generateEmbedding('巴黎是法国的首都');

    expect(cos(q, related)).toBeGreaterThan(cos(q, unrelated));
  });

  it('crosses languages: a Chinese query finds the matching English conversation', async () => {
    const q = await generateQueryEmbedding('内存泄漏怎么排查');
    const related = await generateEmbedding('the leak came from a connection pool that was never closed');
    const unrelated = await generateEmbedding('Paris is the capital of France');

    expect(cos(q, related)).toBeGreaterThan(cos(q, unrelated));
  });

  it('crosses languages the other way too', async () => {
    const q = await generateQueryEmbedding('why does compaction get stuck');
    const related = await generateEmbedding('compaction 线程池被占满，cumulative rowset 一直堆积');
    const unrelated = await generateEmbedding('巴黎是法国的首都');

    expect(cos(q, related)).toBeGreaterThan(cos(q, unrelated));
  });
});
