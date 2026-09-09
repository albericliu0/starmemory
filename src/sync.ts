// Incremental indexing of the local JSONL transcripts of both harnesses --
// design doc §01/§08/§16. Multiple `sync` processes can run concurrently (one
// per SessionStart hook firing, from Claude Code or from Codex) with no
// app-level lock: LMDB's single-writer transaction is enforced by the engine
// itself (flock), unlike episodic-memory's hand-rolled file-lock.ts.
import fs from 'node:fs';
import path from 'node:path';
import { detectHarness, parseConversation, projectFromPath } from './parser.js';
import { archivePathFor, copyIfChanged, defaultArchiveRoot } from './archive.js';
import { DEFAULT_SUMMARY_LIMIT, summarizeQuietConversations, type SummaryCandidate, type SummaryOptions } from './summaries.js';
import { defaultTtlDays, expireOldConversations, ttlCutoffMs } from './ttl.js';
import { EMBEDDING_MODEL, generateExchangeEmbedding } from './embeddings.js';
import {
  HARNESS_INDEX_KEY,
  exchangesFrom,
  insertExchangesForFile,
  putVector,
  reindexHarness,
  syncCursorKey,
  type StoreHandle,
} from './store.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex } from './text-index.js';

/** Where each harness keeps its transcripts. The overrides are the ones the
 * harnesses themselves honour, so a profile that moved its config dir still
 * gets indexed. Missing directories are fine: walkJsonlFiles yields nothing. */
export function defaultTranscriptDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? '';
  return [
    path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects'),
    path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions'),
  ];
}

/** Which embedding model every vector in the store came from. */
export const EMBEDDING_MODEL_KEY = 'embedding_model';

export interface EmbeddingMigrationResult {
  /** Exchanges whose vector was recomputed with the current model. */
  reembedded: number;
}

/** Bring every stored vector onto the current embedding model.
 *
 * Vectors from different models cannot be compared, so a model change means
 * re-embedding the whole store, not just new rows. A store with no recorded
 * model is treated the same way: it predates this check, so its vectors are
 * assumed stale. Subagent turns get no vector, matching insertExchange(). */
export async function ensureEmbeddingModel(store: StoreHandle): Promise<EmbeddingMigrationResult> {
  const recorded = store.meta.get(EMBEDDING_MODEL_KEY) as string | undefined;
  if (recorded === EMBEDDING_MODEL) return { reembedded: 0 };

  let reembedded = 0;
  for (const exchange of exchangesFrom(store, 0)) {
    if (exchange.isSidechain) continue;
    const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage);
    putVector(store, exchange.id, embedding);
    reembedded++;
  }
  store.meta.putSync(EMBEDDING_MODEL_KEY, EMBEDDING_MODEL);
  return { reembedded };
}

/** Next exchange id the text index for one schema version has not seen. Kept
 * in LMDB, not in tantivy, because LMDB is the source of truth (design doc §09).
 * One key per schema version, to match the one directory per schema version
 * (versionedTextIndexDir): a v1 and a v2 index each advance their own cursor,
 * so neither mistakes the other's progress for its own. */
export function textCursorKey(version: number): string {
  return `text_index_cursor:v${version}`;
}

export interface TextSyncResult {
  /** Another process held the writer lock. Our rows are in LMDB and whoever
   * takes the lock next will index them, so this is not a failure. */
  skipped: boolean;
  /** The index had no documents although the cursor said rows were indexed:
   * its directory was wiped or is brand new, so every row was reloaded. */
  rebuilt: boolean;
  indexed: number;
}

/** Bring the BM25 index up to date with LMDB.
 *
 * The whole design of this function is "whoever gets the lock does the work
 * everyone else could not do". A process that cannot take the lock returns
 * immediately without touching the cursor, so its rows stay pending and the next
 * lock holder indexes them from the cursor forward (design doc §09). */
export function syncTextIndex(store: StoreHandle, index: TextIndex): TextSyncResult {
  if (!index.tryAcquireWriter()) {
    return { skipped: true, rebuilt: false, indexed: 0 };
  }

  const cursorKey = textCursorKey(index.version);
  let cursor = (store.meta.get(cursorKey) as number | undefined) ?? 0;
  let rebuilt = false;

  if (cursor > 0 && index.numDocs() === 0) {
    // LMDB remembers indexing rows this directory does not hold: it was wiped,
    // or it is the first open of this schema's directory. The index is a cache
    // over LMDB, so reload everything rather than trust the cursor.
    cursor = 0;
    rebuilt = true;
  }

  const pending = exchangesFrom(store, cursor);
  if (pending.length > 0) {
    index.addExchanges(pending);
  }

  // One commit per batch: it fsyncs, so doing it per document would dominate.
  index.commit();

  if (pending.length > 0) {
    store.meta.putSync(cursorKey, pending[pending.length - 1].id + 1);
  }

  return { skipped: false, rebuilt, indexed: pending.length };
}

function* walkJsonlFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

export interface SyncOptions {
  /** Where transcript copies live (design doc archive-and-summaries §03).
   * Tests point this at a temp dir; the default is ~/.config/starmemory/archive. */
  archiveRoot?: string;
  /** Summary step settings (design doc archive-and-summaries §04); tests inject
   * fake summarizers here. `limit` defaults to STARMEMORY_SUMMARY_LIMIT or 10. */
  summaries?: SummaryOptions;
  /** Expiry settings (design doc archive-and-summaries §13). `days` defaults to
   * STARMEMORY_TTL_DAYS or 180; 0 disables. `now` is for tests. */
  ttl?: { days?: number; now?: number; log?: (line: string) => void };
}

export interface SyncResult {
  filesScanned: number;
  exchangesIndexed: number;
  /** Transcripts copied into the archive this run. */
  archived: number;
  /** Summary files written this run (including empty sentinels). */
  summarized: number;
  /** Summaries that failed and were left as error sentinels to retry. */
  summaryFailed: number;
  /** Rows removed because their conversation passed the TTL. */
  expired: number;
  /** Conversations (files) removed for the same reason. */
  expiredFiles: number;
  /** True when expiry was skipped because another process held the text writer. */
  expireSkipped: boolean;
  /** Vectors recomputed because the embedding model changed (see ensureEmbeddingModel). */
  reembedded: number;
  /** Documents added to the BM25 index this run. */
  textIndexed: number;
  /** True when another process held the BM25 writer lock (design doc §09). */
  textSkipped: boolean;
}

function* walkAll(dirs: string[]): Generator<string> {
  for (const dir of dirs) yield* walkJsonlFiles(dir);
}

/** Scans every transcript of every harness, inserts exchanges past each file's
 * last-synced cursor, and rebuilds the vector index once at the end (design doc
 * §07: rebuilding from scratch is a sub-second operation at this scale, so
 * there's no need for incremental graph maintenance). */
export async function syncAll(
  store: StoreHandle,
  index: VectorIndex,
  transcriptsDirs: string | string[] = defaultTranscriptDirs(),
  textIndex?: TextIndex,
  options: SyncOptions = {}
): Promise<SyncResult> {
  let filesScanned = 0;
  let exchangesIndexed = 0;
  let archived = 0;
  const archiveRoot = options.archiveRoot ?? defaultArchiveRoot();
  const candidates: SummaryCandidate[] = [];
  const ttlDays = options.ttl?.days ?? defaultTtlDays();
  const now = options.ttl?.now ?? Date.now();
  const cutoff = ttlDays > 0 ? ttlCutoffMs(ttlDays, now) : Number.NEGATIVE_INFINITY;

  // Before touching anything else: if the model changed, every existing vector
  // is stale and the graph built from them would be meaningless.
  const migration = await ensureEmbeddingModel(store);

  // Rows written before Codex support have no harness index entry. Backfill
  // once; the key makes every later sync skip the walk (design doc §16).
  if (store.meta.get(HARNESS_INDEX_KEY) !== 1) {
    reindexHarness(store);
    store.meta.putSync(HARNESS_INDEX_KEY, 1);
  }

  const dirs = Array.isArray(transcriptsDirs) ? transcriptsDirs : [transcriptsDirs];
  for (const filePath of walkAll(dirs)) {
    filesScanned++;
    // Already past the TTL before we ever saw it: not copied, not indexed.
    // Only matters when Claude Code's own 30-day cleanup is turned off.
    if (fs.statSync(filePath).mtimeMs < cutoff) continue;
    const project = projectFromPath(filePath);
    // This read is only an optimisation, to avoid embedding rows another sync
    // has already stored. The authoritative check is inside the insert
    // transaction below, which re-reads the cursor under LMDB's write lock.
    const cursor = (store.meta.get(syncCursorKey(filePath)) as number | undefined) ?? 0;

    // Parse the source, then copy it into the archive and point every row at
    // the copy. The project comes from the parse, not the path: a Codex rollout
    // sits under a date directory, its project is the cwd in session_meta. The
    // cursor stays keyed by the source path: switching the key would make every
    // file look new on the first sync after this change and double every row.
    const parsed = await parseConversation(filePath, project, filePath);
    const harness = parsed[0]?.harness ?? (await detectHarness(filePath));
    const resolvedProject = parsed[0]?.project ?? project;
    const copy = archivePathFor(archiveRoot, harness, resolvedProject, filePath);
    if (await copyIfChanged(filePath, copy)) archived++;
    const exchanges = parsed.map((e) => ({ ...e, archivePath: copy }));
    candidates.push({
      archivePath: copy,
      harness,
      project: resolvedProject,
      sessionId: exchanges[0]?.sessionId,
      sourceMtimeMs: fs.statSync(filePath).mtimeMs,
    });
    const newExchanges = exchanges.filter((e) => e.lineEnd > cursor);
    if (newExchanges.length === 0) continue;

    const pending = [];
    for (const exchange of newExchanges) {
      // Subagent turns are never returned by vector search, so embedding them
      // would be paying the slowest part of sync for nothing.
      const embedding = exchange.isSidechain
        ? null
        : await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage);
      pending.push({ exchange: { ...exchange, embeddingVersion: 1 }, embedding });
    }
    const { ids } = insertExchangesForFile(store, filePath, pending);
    exchangesIndexed += ids.length;
  }

  // Expiry before the graph rebuild, so the rebuild already reflects it. It
  // takes the text writer; syncTextIndex below reuses the same handle's lock.
  const expiry = expireOldConversations(store, textIndex, {
    ttlDays,
    now,
    archiveRoot,
    log: options.ttl?.log ?? ((line) => process.stderr.write(`${line}\n`)),
  });

  if (exchangesIndexed > 0 || migration.reembedded > 0 || expiry.rows > 0) {
    index.rebuild(store);
  }

  // Always attempt this, even when we added nothing: another process may have
  // written rows it could not index, and we may be the one holding the lock now.
  const textSync = textIndex ? syncTextIndex(store, textIndex) : undefined;

  // Last, and bounded: a few quiet conversations get a summary. Never blocks
  // indexing; a failure is a sentinel file and a log line.
  const envLimit = Number(process.env.STARMEMORY_SUMMARY_LIMIT);
  const limit = options.summaries?.limit ?? (Number.isFinite(envLimit) && process.env.STARMEMORY_SUMMARY_LIMIT !== undefined ? envLimit : DEFAULT_SUMMARY_LIMIT);
  const summaries = await summarizeQuietConversations(candidates, { ...options.summaries, limit });

  return {
    filesScanned,
    exchangesIndexed,
    archived,
    summarized: summaries.written,
    summaryFailed: summaries.failed,
    expired: expiry.rows,
    expiredFiles: expiry.files,
    expireSkipped: expiry.skipped,
    reembedded: migration.reembedded,
    textIndexed: textSync?.indexed ?? 0,
    textSkipped: textSync?.skipped ?? false,
  };
}
