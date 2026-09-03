// TypeScript face of the Tantivy BM25 addon -- design doc §08.
//
// The addon is deliberately ignorant of our record shape, so this file owns the
// translation: an exchange becomes one indexed document, and ISO timestamps
// become the epoch milliseconds the native range filter works in.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationExchange } from './types.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

interface NativeDoc {
  id: number;
  text: string;
  project: string;
  sessionId: string;
  timestampMs: number;
  isSidechain: boolean;
}

interface NativeFilter {
  project?: string;
  sessionId?: string;
  afterMs?: number;
  beforeMs?: number;
}

interface NativeHit {
  id: number;
  score: number;
}

interface NativeIndex {
  tryAcquireWriter(): boolean;
  addDocuments(docs: NativeDoc[]): void;
  commit(): void;
  deleteAll(): void;
  search(query: string, limit: number, filter: NativeFilter | null): NativeHit[];
  numDocs(): number;
}

interface NativeModule {
  TextIndex: { open(path: string): NativeIndex };
  indexVersion(): number;
}

/** Built from source by `npm run build:native`; `dist/` and `src/` sit at the
 * same depth relative to the crate, so one relative path serves both. */
const ADDON_PATH = path.resolve(here, '..', 'native-text', 'starmemory_text.node');

let cachedModule: NativeModule | null = null;

function addon(): NativeModule {
  if (!cachedModule) {
    if (!fs.existsSync(ADDON_PATH)) {
      throw new Error(
        `starmemory text index addon not found at ${ADDON_PATH} -- run "npm run build:native"`
      );
    }
    cachedModule = require(ADDON_PATH) as NativeModule;
  }
  return cachedModule;
}

/** True when the addon has been built. Callers that can still work without BM25
 * (see store.ts's substring fallback) use this instead of catching a throw. */
export function isTextIndexAvailable(): boolean {
  return fs.existsSync(ADDON_PATH);
}

export interface TextSearchFilter {
  project?: string;
  sessionId?: string;
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
export function documentForExchange(exchange: ConversationExchange): NativeDoc {
  return {
    id: exchange.id,
    text: `${exchange.userMessage}\n\n${exchange.assistantMessage}`,
    project: exchange.project,
    sessionId: exchange.sessionId ?? '',
    timestampMs: toEpochMs(exchange.timestamp) ?? 0,
    isSidechain: exchange.isSidechain === true,
  };
}

function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

export class TextIndex {
  private constructor(
    private readonly native: NativeIndex,
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
      afterMs: toEpochMs(filter.after),
      beforeMs: toEpochMs(filter.before),
    });
  }

  numDocs(): number {
    return this.native.numDocs();
  }
}
