// HNSW vector search -- design doc §07.
//
// Backed by usearch inside the single Rust addon. The index file is a
// rebuildable cache, not source of truth: that is `vectors` in store.ts. On
// open() we load the file if it is there and usable, otherwise we rebuild from
// every vector in LMDB.
//
// A rebuild never touches a file a reader may have mapped. It writes a fresh
// file (`index-v2.g7-48213.hnsw`: generation 7, written by pid 48213) and
// records that file's name in LMDB meta; a reader switches when the name
// changes. The pid is what keeps two syncs that rebuild at the same moment
// (sync-race.test.ts shows they do) from writing the same path, which is the
// in-place overwrite this whole scheme exists to avoid. That is the one
// mechanism on every platform: Windows refuses to replace or delete a mapped
// file, so the POSIX rename trick was never going to travel (design doc
// windows-support §07).
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDING_DIM } from './embeddings.js';
import { allVectors, type StoreHandle } from './store.js';
import { addon, type NativeVectorOptions, type NativeVectorSearcher } from './addon.js';

/** LMDB meta key holding the file name (basename) readers should be on. */
export const VECTOR_INDEX_FILE_KEY = 'vector_index_file';

/** The addon generation is spliced into the file name: `index.hnsw` becomes
 * `index-v2.hnsw`. Two builds with different on-disk layouts then never read
 * each other's file (design doc §10, as for the text index directory). This
 * is the pre-generation name; see generationPath for what is written now. */
export function versionedVectorIndexPath(basePath: string): string {
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, basePath.length - ext.length);
  return `${stem}-v${addon().vectorIndexVersion()}${ext}`;
}

/** `index.hnsw`, generation 3, pid 48213 -> `index-v2.g3-48213.hnsw`. */
export function generationPath(basePath: string, generation: number, pid = process.pid): string {
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, basePath.length - ext.length);
  return `${stem}-v${addon().vectorIndexVersion()}.g${generation}-${pid}${ext}`;
}

/** The generation number encoded in an index file name, or undefined. */
export function generationOf(file: string): number | undefined {
  const m = path.basename(file).match(/\.g(\d+)(?:-\d+)?\.[^.]+$/);
  return m ? Number(m[1]) : undefined;
}

/** The file the store says readers should be on, or undefined before the first
 * build. Stored as a basename; resolved beside `basePath`. */
export function currentIndexFile(store: StoreHandle, basePath: string): string | undefined {
  const raw = store.meta.get(VECTOR_INDEX_FILE_KEY);
  if (typeof raw !== 'string' || raw === '' || raw.includes('/') || raw.includes('\\')) return undefined;
  return path.join(path.dirname(basePath), raw);
}

/** Delete the file a build older than versionedVectorIndexPath left at the
 * bare base path. It is a cache, so nothing is lost. */
export function removeLegacyVectorIndex(basePath: string): boolean {
  try {
    if (!fs.statSync(basePath).isFile()) return false;
  } catch {
    return false;
  }
  fs.rmSync(basePath, { force: true });
  return true;
}

/** How long another generation's file may go unwritten before it is pruned.
 * A build that is still in use rewrites its file on every sync that indexes
 * something, so an old mtime means an abandoned generation. */
export const VECTOR_INDEX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Files that belong to this index family: `<stem>-v<N>.hnsw` (legacy) and
 * `<stem>-v<N>.g<G>-<pid>.hnsw`. */
function familyPattern(basePath: string): RegExp {
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  return new RegExp(`^${escapeRegExp(stem)}-v\\d+(?:\\.g\\d+(?:-\\d+)?)?${escapeRegExp(ext)}$`);
}

function sameVersionPattern(basePath: string): RegExp {
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  return new RegExp(`^${escapeRegExp(stem)}-v${addon().vectorIndexVersion()}(?:\\.g\\d+(?:-\\d+)?)?${escapeRegExp(ext)}$`);
}

/** A file younger than this may be another sync's build in progress, or one it
 * has just pointed the store at while we were sweeping. Leave it alone. */
export const SWEEP_MIN_AGE_MS = 60 * 1000;

function listFamily(basePath: string): string[] {
  const parent = path.dirname(basePath);
  const pattern = familyPattern(basePath);
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isFile() && pattern.test(e.name))
      .map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

/** Remove other files of the current version: not the one the store names, not
 * `keep` (our own), and not anything written in the last minute. Best effort:
 * on Windows a file another process still maps cannot be deleted, so the next
 * rebuild tries again. Returns what was removed. */
export function sweepOtherGenerations(
  store: StoreHandle,
  basePath: string,
  keep: string,
  { now = Date.now(), minAgeMs = SWEEP_MIN_AGE_MS }: { now?: number; minAgeMs?: number } = {}
): string[] {
  const named = currentIndexFile(store, basePath);
  const sameVersion = sameVersionPattern(basePath);
  const removed: string[] = [];
  for (const file of listFamily(basePath)) {
    if (file === keep || file === named || !sameVersion.test(path.basename(file))) continue;
    try {
      if (now - fs.statSync(file).mtimeMs < minAgeMs) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // mapped by another process (Windows), or already gone
    }
  }
  return removed;
}

/** Remove other *versions'* index files that have sat idle. Never touches the
 * current version's files, nor anything not shaped like a sibling of ours.
 * Returns the paths removed. */
export function pruneStaleVectorIndexFiles(
  basePath: string,
  { now = Date.now(), maxIdleMs = VECTOR_INDEX_IDLE_MS }: { now?: number; maxIdleMs?: number } = {}
): string[] {
  const sameVersion = sameVersionPattern(basePath);
  const removed: string[] = [];
  for (const candidate of listFamily(basePath)) {
    if (sameVersion.test(path.basename(candidate))) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs <= maxIdleMs) continue;
    try {
      fs.rmSync(candidate, { force: true });
      removed.push(candidate);
    } catch {
      // Another process may have got there first.
    }
  }
  return removed;
}

/** Unchanged from the faiss build, so recall stays comparable. Embeddings are
 * already L2-normalised, so the engine's inner product is cosine similarity. */
export interface HnswOptions {
  dim: number;
  /** HNSW's M: graph connectivity. */
  connectivity: number;
  expansionAdd: number;
  expansionSearch: number;
}

const DEFAULT_OPTIONS: HnswOptions = {
  dim: EMBEDDING_DIM,
  connectivity: 16,
  expansionAdd: 40,
  expansionSearch: 64,
};

function toNative(options: HnswOptions): NativeVectorOptions {
  return {
    dim: options.dim,
    connectivity: options.connectivity,
    expansionAdd: options.expansionAdd,
    expansionSearch: options.expansionSearch,
  };
}

export class VectorIndex {
  private searcher: NativeVectorSearcher | null = null;
  /** The file `searcher` was opened from. */
  private opened: string | null = null;
  /** A file we tried and failed to open. Not retried until the store names
   * another one, so one bad file does not cost a failed open per search. */
  private rejected: string | null = null;

  private constructor(
    private readonly store: StoreHandle,
    private readonly basePath: string,
    private readonly options: HnswOptions
  ) {}

  /** `basePath` is the unversioned name, `~/.config/starmemory/index.hnsw`;
   * the file actually used is whatever the store names (currentIndexFile). */
  static open(store: StoreHandle, basePath: string, options: Partial<HnswOptions> = {}): VectorIndex {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    removeLegacyVectorIndex(basePath);
    const index = new VectorIndex(store, basePath, opts);

    let file = currentIndexFile(store, basePath);
    if (file === undefined) {
      // A store from before generations: its one file becomes g0 if we can
      // move it. Another process starting at the same moment loses the
      // rename and rebuilds instead, into its own pid-named file.
      const legacy = versionedVectorIndexPath(basePath);
      const adopted = generationPath(basePath, 0);
      if (fs.existsSync(legacy)) {
        try {
          fs.renameSync(legacy, adopted);
          store.meta.putSync(VECTOR_INDEX_FILE_KEY, path.basename(adopted));
          file = adopted;
        } catch {
          // fall through to a rebuild
        }
      }
    }

    if (file === undefined) {
      index.rebuild(store);
    } else {
      try {
        index.openSearcher(file);
      } catch {
        // Missing or damaged. It is a cache, so build it again.
        index.rebuild(store);
      }
    }
    pruneStaleVectorIndexFiles(basePath);
    return index;
  }

  /** Rebuild the whole graph from every vector currently in LMDB into the next
   * generation, then point the store at it and drop the older files.
   *
   * Wholesale rather than incremental on purpose (design doc §07): inserting
   * into an HNSW graph degrades it, and at this corpus size a full rebuild is a
   * sub-second operation. Subagent turns never appear here because store.ts
   * gives them no vector. */
  rebuild(store: StoreHandle): void {
    const { ids, flat } = allVectors(store, this.options.dim);
    const current = currentIndexFile(store, this.basePath);
    const next = (current ? generationOf(current) ?? -1 : -1) + 1;
    const file = generationPath(this.basePath, next);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    addon().buildVectorIndex(toNative(this.options), Float64Array.from(ids), flat, file);
    store.meta.putSync(VECTOR_INDEX_FILE_KEY, path.basename(file));
    this.openSearcher(file);
    sweepOtherGenerations(store, this.basePath, file);
  }

  private openSearcher(file: string): void {
    const next = addon().VectorSearcher.open(toNative(this.options), file);
    this.searcher?.close();
    this.searcher = next;
    this.opened = file;
    this.rejected = null;
  }

  /** Switch to the generation the store names if it is not the one we have. A
   * reader keeps its old graph until then; the old file stays on disk at least
   * until we let go of it, so an unreadable replacement leaves the current
   * searcher in place.
   *
   * Called by the query layer once per query, not per search(): a multi-concept
   * query runs several searches and they must all see one graph. */
  refresh(): void {
    if (!this.searcher) return;
    const current = currentIndexFile(this.store, this.basePath);
    if (current === undefined || current === this.opened || current === this.rejected) return;
    try {
      this.openSearcher(current);
    } catch (error) {
      // Incompatible or damaged file: keep answering from the old graph.
      this.rejected = current;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `starmemory: vector index ${path.basename(current)} cannot be opened (${reason}); still using ${this.opened ? path.basename(this.opened) : 'nothing'}\n`
      );
    }
  }

  /** The file the current searcher was opened from. */
  get currentPath(): string | null {
    return this.opened;
  }

  /** Unmap the index file. On Windows a mapped file cannot be deleted, so a
   * process that is done with an index (a test tearing down, a CLI run about
   * to exit) should close rather than wait for garbage collection. Idempotent;
   * search() and size() answer empty afterwards. */
  close(): void {
    this.searcher?.close();
    this.searcher = null;
    this.opened = null;
  }

  /** Top-k by cosine similarity, optionally restricted to `filterIds`.
   *
   * The filter runs inside the graph traversal, so a filtered query does not
   * over-fetch and trim (design doc §07/§08). */
  search(query: Float32Array, k: number, filterIds?: number[]): { id: number; score: number }[] {
    if (!this.searcher) return [];
    return this.searcher.search(
      query,
      k,
      filterIds ? Float64Array.from(filterIds) : null
    );
  }

  /** Vectors currently in the graph. */
  size(): number {
    return this.searcher ? this.searcher.len() : 0;
  }
}
