// HNSW vector search -- design doc §07.
//
// Backed by usearch inside the single Rust addon. The index file is a
// rebuildable cache, not source of truth: that is `vectors` in store.ts. On
// open() we load the file if it is there and usable, otherwise we rebuild from
// every vector in LMDB.
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDING_DIM } from './embeddings.js';
import { allVectors, type StoreHandle } from './store.js';
import { addon, type NativeVectorOptions, type NativeVectorSearcher } from './addon.js';

/** The addon generation is spliced into the file name: `index.hnsw` becomes
 * `index-v2.hnsw`. Two builds with different on-disk layouts then never read
 * each other's file, even when one is a server that stays up across the
 * upgrade and reopens whatever appears at its path (design doc §10, as for
 * the text index directory). */
export function versionedVectorIndexPath(basePath: string): string {
  const ext = path.extname(basePath);
  const stem = basePath.slice(0, basePath.length - ext.length);
  return `${stem}-v${addon().vectorIndexVersion()}${ext}`;
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

/** Remove other generations' index files that have sat idle. Never touches
 * our own, nor anything not shaped like a sibling of ours. Returns the paths
 * removed. */
export function pruneStaleVectorIndexFiles(
  basePath: string,
  { now = Date.now(), maxIdleMs = VECTOR_INDEX_IDLE_MS }: { now?: number; maxIdleMs?: number } = {}
): string[] {
  const parent = path.dirname(basePath);
  const mine = versionedVectorIndexPath(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  const pattern = new RegExp(`^${escapeRegExp(stem)}-v\\d+${escapeRegExp(ext)}$`);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const candidate = path.join(parent, entry.name);
    if (candidate === mine) continue;
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

export interface HnswOptions {
  dim: number;
  /** HNSW's M: graph connectivity. */
  connectivity: number;
  expansionAdd: number;
  expansionSearch: number;
}

/** Unchanged from the faiss build, so recall stays comparable. Embeddings are
 * already L2-normalised, so the engine's inner product is cosine similarity. */
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

/** What identifies the file a searcher was opened from. The sync writes a new
 * file and renames it into place (vector.rs), so a replaced index has a new
 * inode; mtime and size cover a filesystem that recycles inode numbers. */
interface FileIdentity {
  ino: number;
  mtimeMs: number;
  size: number;
}

function identityOf(indexPath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(indexPath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameFile(a: FileIdentity | null, b: FileIdentity | null): boolean {
  return a !== null && b !== null && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export class VectorIndex {
  private searcher: NativeVectorSearcher | null = null;
  /** The file `searcher` was opened from, so a rebuild by another process
   * (the SessionStart sync while this MCP server is alive) is noticed. */
  private opened: FileIdentity | null = null;
  /** A replacement we tried and failed to open. Not retried until the file
   * changes again, so one bad file does not cost a failed open per search. */
  private rejected: FileIdentity | null = null;

  private constructor(
    private readonly indexPath: string,
    private readonly options: HnswOptions
  ) {}

  /** `basePath` is the unversioned name, `~/.config/starmemory/index.hnsw`;
   * the file actually used is versionedVectorIndexPath(basePath). */
  static open(store: StoreHandle, basePath: string, options: Partial<HnswOptions> = {}): VectorIndex {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    removeLegacyVectorIndex(basePath);
    const index = new VectorIndex(versionedVectorIndexPath(basePath), opts);
    try {
      index.openSearcher();
    } catch {
      // Missing or damaged. It is a cache, so build it again.
      index.rebuild(store);
    }
    pruneStaleVectorIndexFiles(basePath);
    return index;
  }

  /** Rebuild the whole graph from every vector currently in LMDB.
   *
   * Wholesale rather than incremental on purpose (design doc §07): inserting
   * into an HNSW graph degrades it, and at this corpus size a full rebuild is a
   * sub-second operation. Subagent turns never appear here because store.ts
   * gives them no vector. */
  rebuild(store: StoreHandle): void {
    const { ids, flat } = allVectors(store, this.options.dim);
    addon().buildVectorIndex(toNative(this.options), Float64Array.from(ids), flat, this.indexPath);
    this.openSearcher();
  }

  /** `identity` is taken before the open on purpose: if the file is replaced
   * between the two, we record the older one and merely reopen once more on the
   * next refresh(); recording the newer one could leave us on a stale mapping. */
  private openSearcher(identity: FileIdentity | null = identityOf(this.indexPath)): void {
    const next = addon().VectorSearcher.open(toNative(this.options), this.indexPath);
    this.searcher?.close();
    this.searcher = next;
    this.opened = identity;
    this.rejected = null;
  }

  /** Reopen if the file on disk is no longer the one we mapped. A reader keeps
   * its old graph until then (the rename in vector.rs keeps that inode alive),
   * so an unreadable replacement leaves the current searcher in place.
   *
   * Called by the query layer once per query, not per search(): a multi-concept
   * query runs several searches and they must all see one graph. */
  refresh(): void {
    if (!this.searcher) return;
    const current = identityOf(this.indexPath);
    if (current === null || sameFile(current, this.opened) || sameFile(current, this.rejected)) return;
    try {
      this.openSearcher(current);
    } catch (error) {
      // Incompatible or damaged file: keep answering from the old graph.
      this.rejected = current;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `starmemory: ${this.indexPath} was replaced but cannot be opened (${reason}); still using the previous index\n`
      );
    }
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
