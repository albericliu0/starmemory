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
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pipeline, type FeatureExtractionPipeline, env } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/jina-embeddings-v2-base-zh';

/** Where downloaded models live: `STARMEMORY_MODEL_CACHE_PATH`, else
 * `~/.config/starmemory/models`. transformers.js defaults to a `.cache` inside
 * its own node_modules, which sits inside the plugin install; every plugin
 * update is a fresh install directory, so the 160 MB model was downloaded
 * again and the first search after an update waited about 90 seconds. One
 * directory shared by every installed version and the dev checkout instead. */
export function defaultModelCacheDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  return processEnv.STARMEMORY_MODEL_CACHE_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'models');
}

/** transformers.js's own default, inside this install's node_modules. Installs
 * made before the shared cache existed have the model here. */
export function legacyModelCacheDir(): string {
  // The package's exports map hides package.json, so resolve the entry point
  // and cut the path back to the package root.
  const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
  const marker = path.join('node_modules', '@huggingface', 'transformers');
  const root = entry.slice(0, entry.indexOf(marker) + marker.length);
  return path.join(root, '.cache');
}

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
export function seedModelCache(sharedDir: string, legacyDir: string, modelId: string): boolean {
  const target = path.join(sharedDir, modelId);
  const source = path.join(legacyDir, modelId);
  if (fs.existsSync(target) || !fs.existsSync(source)) return false;
  const staging = seedStagingPath(sharedDir, modelId);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, staging, { recursive: true });
    fs.renameSync(staging, target);
    return true;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    // Another process finished first: its copy is as good as ours.
    if (fs.existsSync(target)) return false;
    throw err;
  }
}

/** Where seedModelCache copies to before the rename: next to the model,
 * named after this pid. */
export function seedStagingPath(sharedDir: string, modelId: string): string {
  return `${path.join(sharedDir, modelId)}.seed-${process.pid}`;
}

env.allowLocalModels = true;
env.useBrowserCache = false;
env.cacheDir = defaultModelCacheDir();

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

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (!embeddingPipeline) {
    seedModelCache(env.cacheDir!, legacyModelCacheDir(), MODEL_ID);
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
