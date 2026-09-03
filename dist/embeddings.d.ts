export declare const EMBEDDING_DIM = 384;
export declare const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
export declare function initEmbeddings(): Promise<void>;
export declare function generateEmbedding(text: string): Promise<Float32Array>;
export declare function withQueryPrefix(query: string): string;
export declare function generateQueryEmbedding(query: string): Promise<Float32Array>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string): Promise<Float32Array>;
