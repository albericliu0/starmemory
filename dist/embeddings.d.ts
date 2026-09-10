export declare const MODEL_ID = "Xenova/jina-embeddings-v2-base-zh";
/** Where downloaded models live: `STARMEMORY_MODEL_CACHE_PATH`, else
 * `~/.config/starmemory/models`. transformers.js defaults to a `.cache` inside
 * its own node_modules, which sits inside the plugin install; every plugin
 * update is a fresh install directory, so the 160 MB model was downloaded
 * again and the first search after an update waited about 90 seconds. One
 * directory shared by every installed version and the dev checkout instead. */
export declare function defaultModelCacheDir(processEnv?: NodeJS.ProcessEnv): string;
/** transformers.js's own default, inside this install's node_modules. Installs
 * made before the shared cache existed have the model here. */
export declare function legacyModelCacheDir(): string;
/** Copy `modelId` from an old per-install cache into the shared one, so the
 * first run after this change costs a local copy rather than a download.
 * Returns whether anything was copied: nothing when the shared cache already
 * has the model, or the old cache never had it.
 *
 * The SessionStart hook's sync and the MCP server start at the same moment
 * and both call this, so the copy goes to a staging directory named after
 * this pid and is renamed into place in one step: a reader never finds a
 * half-copied model under the real name, and the loser of the race simply
 * discards its copy. */
export declare function seedModelCache(sharedDir: string, legacyDir: string, modelId: string): boolean;
/** Where seedModelCache copies to before the rename: next to the model,
 * named after this pid. */
export declare function seedStagingPath(sharedDir: string, modelId: string): string;
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
