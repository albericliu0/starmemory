export declare const EMBEDDING_DIM = 768;
/** Identity of the model every stored vector came from. A store whose recorded
 * model differs from this is re-embedded in full before it is searched: vectors
 * from two models are not comparable, and here they are not even the same size. */
export declare const EMBEDDING_MODEL = "Xenova/jina-embeddings-v2-base-zh/q8/768";
/** jina-v2 is instruction-free: no "query:" or "Represent this sentence" prefix
 * on either side, unlike the BGE-v1.5 and E5 families. Kept as a function so the
 * call sites stay symmetric with the passage path. */
export declare const BGE_QUERY_PREFIX = "";
export declare function initEmbeddings(): Promise<void>;
export declare function generateEmbedding(text: string): Promise<Float32Array>;
export declare function withQueryPrefix(query: string): string;
export declare function generateQueryEmbedding(query: string): Promise<Float32Array>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string): Promise<Float32Array>;
