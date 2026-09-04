// Embedding pipeline -- design doc §06, revised to a bilingual model.
//
// The original bge-small-en-v1.5 was English-only: on a 10-topic ranking test a
// Chinese query found its Chinese answer 40% of the time. bge-m3 fixed that but
// costs 1.35 GB of RSS per process, because its 250k-row XLM-R vocabulary is
// dequantised to fp32 at load -- and a memory plugin holds one process per
// Claude Code session. jina-embeddings-v2-base-zh is trained for exactly
// Chinese + English with a 61k vocabulary: 493 MB RSS, 156 MB on disk, and on
// the same test 80/70/80/80 (zh→zh, en→en, zh→en, en→zh) against bge-m3's
// 80/80/80/80 -- one query apart. Apache-2.0. Design doc §18/§19 has the numbers.
import { pipeline, env } from '@huggingface/transformers';
env.allowLocalModels = true;
env.useBrowserCache = false;
const MODEL_ID = 'Xenova/jina-embeddings-v2-base-zh';
const MODEL_DTYPE = 'q8';
export const EMBEDDING_DIM = 768;
/** Identity of the model every stored vector came from. A store whose recorded
 * model differs from this is re-embedded in full before it is searched: vectors
 * from two models are not comparable, and here they are not even the same size. */
export const EMBEDDING_MODEL = `${MODEL_ID}/${MODEL_DTYPE}/${EMBEDDING_DIM}`;
/** jina-v2 is instruction-free: no "query:" or "Represent this sentence" prefix
 * on either side, unlike the BGE-v1.5 and E5 families. Kept as a function so the
 * call sites stay symmetric with the passage path. */
export const BGE_QUERY_PREFIX = '';
let embeddingPipeline = null;
export async function initEmbeddings() {
    if (!embeddingPipeline) {
        embeddingPipeline = (await pipeline('feature-extraction', MODEL_ID, {
            dtype: MODEL_DTYPE,
            progress_callback: () => { },
        }));
    }
}
export async function generateEmbedding(text) {
    if (!embeddingPipeline)
        await initEmbeddings();
    const truncated = text.slice(0, 2000);
    const output = await embeddingPipeline(truncated, { pooling: 'mean', normalize: true });
    return Float32Array.from(output.data);
}
export function withQueryPrefix(query) {
    return query.startsWith(BGE_QUERY_PREFIX) ? query : BGE_QUERY_PREFIX + query;
}
export async function generateQueryEmbedding(query) {
    return generateEmbedding(withQueryPrefix(query));
}
export async function generateExchangeEmbedding(userMessage, assistantMessage) {
    return generateEmbedding(`User: ${userMessage}\n\nAssistant: ${assistantMessage}`);
}
