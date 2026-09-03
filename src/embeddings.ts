// Embedding pipeline -- design doc §06. Logic ported as-is from episodic-memory's
// src/embeddings.ts: same model, same asymmetric query/passage handling, same
// truncation length. Only the runtime differs (we're a Node process the whole
// time, so @huggingface/transformers stays -- the design doc's "switch to
// ONNX Runtime C++" only applies if this ever becomes a pure native addon).
import { pipeline, type FeatureExtractionPipeline, env } from '@huggingface/transformers';

env.allowLocalModels = true;
env.useBrowserCache = false;

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const MODEL_DTYPE = 'q8';
export const EMBEDDING_DIM = 384;
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

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
