// Embedding pipeline -- design doc §06, revised to a multilingual model.
//
// The original bge-small-en-v1.5 was English-only: on a 10-topic ranking test a
// Chinese query found its Chinese answer 40% of the time and crossed languages
// 30-50% of the time. bge-m3 scored 80% in all four directions (zh→zh, en→en,
// zh→en, en→zh) and was the only candidate that did not regress English. It
// costs 561 MB on disk, ~350 MB more RSS, and 60 ms per long passage vs 13 ms.
// multilingual-e5-small was the runner-up: same 384 dims as before and 129 MB,
// but English dropped from 80% to 60%.
import { pipeline, type FeatureExtractionPipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;
env.useBrowserCache = false;

const MODEL_ID = 'Xenova/bge-m3';
const MODEL_DTYPE = 'q8';
export const EMBEDDING_DIM = 1024;
/** Identity of the model every stored vector came from. A store whose recorded
 * model differs from this is re-embedded in full before it is searched: vectors
 * from two models are not comparable, and here they are not even the same size. */
export const EMBEDDING_MODEL = `${MODEL_ID}/${MODEL_DTYPE}/${EMBEDDING_DIM}`;

/** bge-m3 is instruction-free: no "query:" or "Represent this sentence" prefix
 * on either side, unlike the BGE-v1.5 and E5 families. Kept as a function so the
 * call sites stay symmetric with the passage path. */
export const BGE_QUERY_PREFIX = '';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (!embeddingPipeline) {
    embeddingPipeline = (await pipeline('feature-extraction', MODEL_ID, {
      dtype: MODEL_DTYPE,
      progress_callback: () => {},
    })) as FeatureExtractionPipeline;
  }
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (!embeddingPipeline) await initEmbeddings();
  const truncated = text.slice(0, 2000);
  const output = await embeddingPipeline!(truncated, { pooling: 'mean', normalize: true });
  return Float32Array.from(output.data as Float32Array);
}

export function withQueryPrefix(query: string): string {
  return query.startsWith(BGE_QUERY_PREFIX) ? query : BGE_QUERY_PREFIX + query;
}

export async function generateQueryEmbedding(query: string): Promise<Float32Array> {
  return generateEmbedding(withQueryPrefix(query));
}

export async function generateExchangeEmbedding(
  userMessage: string,
  assistantMessage: string
): Promise<Float32Array> {
  return generateEmbedding(`User: ${userMessage}\n\nAssistant: ${assistantMessage}`);
}
