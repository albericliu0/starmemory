// Time to live for a conversation: once nothing has been said in it for
// STARMEMORY_TTL_DAYS (180 by default), it leaves the memory for good. The
// rows and vector in LMDB, its documents in the text index, the archive copy
// and the summary all go together, so a search never returns something that
// cannot be opened. Design doc archive-and-summaries §13.
import fs from 'node:fs';
import { archivePathFor, summaryPathFor } from './archive.js';
import { deleteExchanges, exchangesFrom, type StoreHandle } from './store.js';
import type { TextIndex } from './text-index.js';
import type { ConversationExchange } from './types.js';

export const DEFAULT_TTL_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `STARMEMORY_TTL_DAYS`; 0 (or a non-number) disables expiry. */
export function defaultTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  if (env.STARMEMORY_TTL_DAYS === undefined) return DEFAULT_TTL_DAYS;
  const days = Number(env.STARMEMORY_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

export function ttlCutoffMs(ttlDays: number, now = Date.now()): number {
  return now - ttlDays * DAY_MS;
}

export interface ExpireOptions {
  ttlDays?: number;
  now?: number;
  archiveRoot: string;
  log?: (line: string) => void;
}

export interface ExpireResult {
  /** Rows removed from the store. */
  rows: number;
  /** Conversations (archive files) removed. */
  files: number;
  /** True when another process held the text writer, so nothing was done this run. */
  skipped: boolean;
}

interface Group {
  archivePath: string;
  harness: 'claude' | 'codex';
  project: string;
  ids: number[];
  latestTimestampMs: number;
}

/** When the conversation was last written to: the archive copy's mtime (kept
 * equal to the source's), or, for rows stored before the archive existed and
 * whose source is gone, the newest exchange timestamp. */
function lastActivityMs(group: Group, archiveRoot: string): number {
  const copy = archivePathFor(archiveRoot, group.harness, group.project, group.archivePath);
  for (const candidate of [copy, group.archivePath]) {
    try {
      return fs.statSync(candidate).mtimeMs;
    } catch {
      // try the next
    }
  }
  return group.latestTimestampMs;
}

function groupByFile(rows: ConversationExchange[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const g = groups.get(r.archivePath) ?? {
      archivePath: r.archivePath,
      harness: r.harness ?? 'claude',
      project: r.project,
      ids: [],
      latestTimestampMs: 0,
    };
    g.ids.push(r.id);
    g.latestTimestampMs = Math.max(g.latestTimestampMs, Date.parse(r.timestamp) || 0);
    groups.set(r.archivePath, g);
  }
  return [...groups.values()];
}

/** Remove every conversation whose last activity is older than the TTL. Holds
 * the text writer for the duration when a text index is given; if another
 * process has it, nothing is removed this run and the next sync tries again. */
export function expireOldConversations(
  store: StoreHandle,
  textIndex: TextIndex | undefined,
  { ttlDays = defaultTtlDays(), now = Date.now(), archiveRoot, log = () => {} }: ExpireOptions
): ExpireResult {
  const result: ExpireResult = { rows: 0, files: 0, skipped: false };
  if (ttlDays <= 0) return result;
  const cutoff = ttlCutoffMs(ttlDays, now);
  const expired = groupByFile(exchangesFrom(store, 0)).filter((g) => lastActivityMs(g, archiveRoot) < cutoff);
  if (expired.length === 0) return result;

  if (textIndex && !textIndex.tryAcquireWriter()) {
    result.skipped = true;
    return result;
  }
  for (const g of expired) {
    result.rows += deleteExchanges(store, g.ids);
    textIndex?.deleteExchanges(g.ids);
    const copy = archivePathFor(archiveRoot, g.harness, g.project, g.archivePath);
    for (const file of new Set([copy, summaryPathFor(copy)])) fs.rmSync(file, { force: true });
    result.files++;
    log(`starmemory: expired ${g.archivePath} (${g.ids.length} exchanges, quiet for more than ${ttlDays} days)`);
  }
  textIndex?.commit();
  return result;
}
