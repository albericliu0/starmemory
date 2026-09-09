// TypeScript face of the Tantivy BM25 half of the addon -- design doc §08.
//
// The addon is deliberately ignorant of our record shape, so this file owns the
// translation: an exchange becomes one indexed document, and ISO timestamps
// become the epoch milliseconds the native range filter works in.
import fs from 'node:fs';
import path from 'node:path';
import { addon, isAddonAvailable, type NativeTextDoc, type NativeTextIndex } from './addon.js';
import { DEFAULT_HARNESS } from './store.js';
import type { ConversationExchange, Harness } from './types.js';

/** True when the addon has been built. Callers that can still work without BM25
 * (see store.ts's substring fallback) use this instead of catching a throw. */
export function isTextIndexAvailable(): boolean {
  return isAddonAvailable();
}

export interface TextSearchFilter {
  project?: string;
  sessionId?: string;
  harness?: Harness;
  /** Inclusive ISO 8601 bounds, matching SearchOptions. */
  after?: string;
  before?: string;
}

export interface TextHit {
  id: number;
  score: number;
}

/** One exchange, flattened into the single text field the schema indexes.
 * Both sides go in: people search for what the assistant said at least as often
 * as for what they asked. */
export function documentForExchange(exchange: ConversationExchange): NativeTextDoc {
  return {
    id: exchange.id,
    text: `${exchange.userMessage}\n\n${exchange.assistantMessage}`,
    project: exchange.project,
    sessionId: exchange.sessionId ?? '',
    harness: exchange.harness ?? DEFAULT_HARNESS,
    timestampMs: toEpochMs(exchange.timestamp) ?? 0,
    isSidechain: exchange.isSidechain === true,
  };
}

function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Where the index for the addon's current schema lives, given the unversioned
 * base path (`.../text` -> `.../text-v2`). Each schema generation gets a sibling
 * directory of its own, so a plugin build with a different schema opens a
 * different directory instead of tripping over, or wiping, this one. Two builds
 * sharing `~/.config/starmemory` (say, the installed plugin and a dev checkout)
 * then coexist, each rebuilding its own index from LMDB (design doc §10). */
export function versionedTextIndexDir(basePath: string): string {
  return `${basePath}-v${addon().indexVersion()}`;
}

/** Delete the index a build older than versionedTextIndexDir left at the bare
 * base path. Only a directory that really is a tantivy index (it has a
 * meta.json) is removed; anything else at that path is not ours to touch.
 * Returns true when something was removed. */
export function removeLegacyTextIndex(basePath: string): boolean {
  if (!fs.existsSync(path.join(basePath, 'meta.json'))) return false;
  fs.rmSync(basePath, { recursive: true, force: true });
  return true;
}

/** What the CLI and the MCP server call: open this build's own index directory
 * under the configured base path, tidying up the pre-versioning one if present. */
export function openVersionedTextIndex(basePath: string): TextIndex {
  removeLegacyTextIndex(basePath);
  return TextIndex.open(versionedTextIndexDir(basePath));
}

export class TextIndex {
  private constructor(
    private readonly native: NativeTextIndex,
    readonly directory: string
  ) {}

  static open(directory: string): TextIndex {
    fs.mkdirSync(directory, { recursive: true });
    return new TextIndex(addon().TextIndex.open(directory), directory);
  }

  /** Schema/analyzer generation of the compiled addon. A stored value that no
   * longer matches this means the index has to be rebuilt (design doc §10). */
  get version(): number {
    return addon().indexVersion();
  }

  /** False means another process is already indexing. Design doc §09: that is a
   * reason to stop, not a reason to fail -- the other process picks up our rows. */
  tryAcquireWriter(): boolean {
    return this.native.tryAcquireWriter();
  }

  addExchanges(exchanges: ConversationExchange[]): void {
    if (exchanges.length === 0) return;
    this.native.addDocuments(exchanges.map(documentForExchange));
  }

  /** fsyncs and republishes the reader. Expensive, so call it once per batch. */
  commit(): void {
    this.native.commit();
  }

  deleteAll(): void {
    this.native.deleteAll();
  }

  search(query: string, limit: number, filter: TextSearchFilter = {}): TextHit[] {
    if (limit <= 0) return [];
    return this.native.search(query, limit, {
      project: filter.project,
      sessionId: filter.sessionId,
      harness: filter.harness,
      afterMs: toEpochMs(filter.after),
      beforeMs: toEpochMs(filter.before),
    });
  }

  numDocs(): number {
    return this.native.numDocs();
  }
}
