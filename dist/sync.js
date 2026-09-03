// Incremental indexing of Claude Code's local JSONL transcripts -- design doc
// §01/§08. Multiple `sync` processes can run concurrently (one per SessionStart
// hook firing) with no app-level lock: LMDB's single-writer transaction is
// enforced by the engine itself (flock), unlike episodic-memory's hand-rolled
// file-lock.ts.
import fs from 'node:fs';
import path from 'node:path';
import { parseConversation, projectFromPath } from './parser.js';
import { generateExchangeEmbedding } from './embeddings.js';
import { exchangesFrom, insertExchange } from './store.js';
const DEFAULT_TRANSCRIPTS_DIR = path.join(process.env.HOME ?? '', '.claude', 'projects');
function metaKey(archivePath) {
    return `synced_line_end:${archivePath}`;
}
/** Next exchange id the text index has not seen. Kept in LMDB, not in tantivy,
 * because LMDB is the source of truth (design doc §09). */
export const TEXT_CURSOR_KEY = 'text_index_cursor';
/** Schema/analyzer generation the current index was built with (design doc §10). */
export const TEXT_VERSION_KEY = 'text_index_version';
/** Bring the BM25 index up to date with LMDB.
 *
 * The whole design of this function is "whoever gets the lock does the work
 * everyone else could not do". A process that cannot take the lock returns
 * immediately without touching the cursor, so its rows stay pending and the next
 * lock holder indexes them from the cursor forward (design doc §09). */
export function syncTextIndex(store, index) {
    if (!index.tryAcquireWriter()) {
        return { skipped: true, rebuilt: false, indexed: 0 };
    }
    const storedVersion = store.meta.get(TEXT_VERSION_KEY);
    let cursor = store.meta.get(TEXT_CURSOR_KEY) ?? 0;
    let rebuilt = false;
    if (storedVersion !== index.version) {
        // An index built by a different schema cannot answer queries parsed by this
        // one. It is a cache, so the fix is to throw it away and reload from LMDB.
        index.deleteAll();
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
        store.meta.putSync(TEXT_CURSOR_KEY, pending[pending.length - 1].id + 1);
    }
    store.meta.putSync(TEXT_VERSION_KEY, index.version);
    return { skipped: false, rebuilt, indexed: pending.length };
}
function* walkJsonlFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkJsonlFiles(full);
        }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            yield full;
        }
    }
}
/** Scans every transcript, inserts exchanges past each file's last-synced
 * cursor, and rebuilds the vector index once at the end (design doc §07:
 * rebuilding from scratch is a sub-second operation at this scale, so there's
 * no need for incremental graph maintenance). */
export async function syncAll(store, index, transcriptsDir = DEFAULT_TRANSCRIPTS_DIR, textIndex) {
    let filesScanned = 0;
    let exchangesIndexed = 0;
    for (const filePath of walkJsonlFiles(transcriptsDir)) {
        filesScanned++;
        const project = projectFromPath(filePath);
        const cursor = store.meta.get(metaKey(filePath)) ?? 0;
        const exchanges = await parseConversation(filePath, project, filePath);
        const newExchanges = exchanges.filter((e) => e.lineEnd > cursor);
        if (newExchanges.length === 0)
            continue;
        for (const exchange of newExchanges) {
            // Subagent turns are never returned by vector search, so embedding them
            // would be paying the slowest part of sync for nothing.
            const embedding = exchange.isSidechain
                ? null
                : await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage);
            insertExchange(store, { ...exchange, embeddingVersion: 1 }, embedding);
            exchangesIndexed++;
        }
        const maxLineEnd = Math.max(...newExchanges.map((e) => e.lineEnd));
        store.meta.putSync(metaKey(filePath), maxLineEnd);
    }
    if (exchangesIndexed > 0) {
        index.rebuild(store);
    }
    // Always attempt this, even when we added nothing: another process may have
    // written rows it could not index, and we may be the one holding the lock now.
    const textSync = textIndex ? syncTextIndex(store, textIndex) : undefined;
    return { filesScanned, exchangesIndexed, textIndexed: textSync?.indexed ?? 0, textSkipped: textSync?.skipped ?? false };
}
