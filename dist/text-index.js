// TypeScript face of the Tantivy BM25 half of the addon -- design doc §08.
//
// The addon is deliberately ignorant of our record shape, so this file owns the
// translation: an exchange becomes one indexed document, and ISO timestamps
// become the epoch milliseconds the native range filter works in.
import fs from 'node:fs';
import path from 'node:path';
import { addon, isAddonAvailable } from './addon.js';
import { DEFAULT_HARNESS } from './store.js';
/** True when the addon has been built. Callers that can still work without BM25
 * (see store.ts's substring fallback) use this instead of catching a throw. */
export function isTextIndexAvailable() {
    return isAddonAvailable();
}
/** One exchange, flattened into the single text field the schema indexes.
 * Both sides go in: people search for what the assistant said at least as often
 * as for what they asked. */
export function documentForExchange(exchange) {
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
function toEpochMs(iso) {
    if (!iso)
        return undefined;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : ms;
}
/** Where the index for the addon's current schema lives, given the unversioned
 * base path (`.../text` -> `.../text-v2`). Each schema generation gets a sibling
 * directory of its own, so a plugin build with a different schema opens a
 * different directory instead of tripping over, or wiping, this one. Two builds
 * sharing `~/.config/starmemory` (say, the installed plugin and a dev checkout)
 * then coexist, each rebuilding its own index from LMDB (design doc §10). */
export function versionedTextIndexDir(basePath) {
    return `${basePath}-v${addon().indexVersion()}`;
}
/** Delete the index a build older than versionedTextIndexDir left at the bare
 * base path. Only a directory that really is a tantivy index (it has a
 * meta.json) is removed; anything else at that path is not ours to touch.
 * Returns true when something was removed. */
export function removeLegacyTextIndex(basePath) {
    if (!fs.existsSync(path.join(basePath, 'meta.json')))
        return false;
    fs.rmSync(basePath, { recursive: true, force: true });
    return true;
}
/** Touched every time a build opens its own directory. Tantivy never writes on
 * open, so without this there would be no record of "someone still uses this". */
export const OPENED_MARKER = '.starmemory-opened';
/** How long another version's directory may go unopened before it is pruned. */
export const TEXT_INDEX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
function markOpened(directory) {
    const marker = path.join(directory, OPENED_MARKER);
    fs.writeFileSync(marker, '');
    const now = new Date();
    fs.utimesSync(marker, now, now);
}
function lastOpenedMs(directory) {
    const marker = path.join(directory, OPENED_MARKER);
    // Directories from before the marker existed have only their own mtime to go by.
    const probe = fs.existsSync(marker) ? marker : directory;
    return fs.statSync(probe).mtimeMs;
}
/** Remove the index directories of *other* schema versions that nobody has
 * opened for `maxIdleMs`. This build's own directory is never a candidate, so
 * a machine that sat idle for months comes back with its index intact. An
 * older build that is still installed keeps touching its directory on every
 * start, which is exactly what keeps that directory alive. Returns what was
 * removed. */
export function pruneStaleTextIndexDirs(basePath, { now = Date.now(), maxIdleMs = TEXT_INDEX_IDLE_MS } = {}) {
    const parent = path.dirname(basePath);
    const mine = versionedTextIndexDir(basePath);
    const pattern = new RegExp(`^${escapeRegExp(path.basename(basePath))}-v\\d+$`);
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const removed = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !pattern.test(entry.name))
            continue;
        const candidate = path.join(parent, entry.name);
        if (candidate === mine)
            continue;
        // Only ever delete something that really is a tantivy index, as removeLegacyTextIndex does.
        if (!fs.existsSync(path.join(candidate, 'meta.json')))
            continue;
        if (now - lastOpenedMs(candidate) <= maxIdleMs)
            continue;
        fs.rmSync(candidate, { recursive: true, force: true });
        removed.push(candidate);
    }
    return removed;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** What the CLI and the MCP server call: open this build's own index directory
 * under the configured base path, record the open, tidy up the pre-versioning
 * directory if present, and prune other versions nobody uses any more. */
export function openVersionedTextIndex(basePath) {
    removeLegacyTextIndex(basePath);
    const index = TextIndex.open(versionedTextIndexDir(basePath));
    markOpened(index.directory);
    pruneStaleTextIndexDirs(basePath);
    return index;
}
export class TextIndex {
    native;
    directory;
    constructor(native, directory) {
        this.native = native;
        this.directory = directory;
    }
    static open(directory) {
        fs.mkdirSync(directory, { recursive: true });
        return new TextIndex(addon().TextIndex.open(directory), directory);
    }
    /** Schema/analyzer generation of the compiled addon. A stored value that no
     * longer matches this means the index has to be rebuilt (design doc §10). */
    get version() {
        return addon().indexVersion();
    }
    /** False means another process is already indexing. Design doc §09: that is a
     * reason to stop, not a reason to fail -- the other process picks up our rows. */
    tryAcquireWriter() {
        return this.native.tryAcquireWriter();
    }
    addExchanges(exchanges) {
        if (exchanges.length === 0)
            return;
        this.native.addDocuments(exchanges.map(documentForExchange));
    }
    /** fsyncs and republishes the reader. Expensive, so call it once per batch. */
    commit() {
        this.native.commit();
    }
    deleteAll() {
        this.native.deleteAll();
    }
    /** Queue these exchanges for removal; commit() applies it. Needs the writer. */
    deleteExchanges(ids) {
        if (ids.length === 0)
            return;
        this.native.deleteDocuments(Float64Array.from(ids));
    }
    search(query, limit, filter = {}) {
        if (limit <= 0)
            return [];
        return this.native.search(query, limit, {
            project: filter.project,
            sessionId: filter.sessionId,
            harness: filter.harness,
            afterMs: toEpochMs(filter.after),
            beforeMs: toEpochMs(filter.before),
        });
    }
    numDocs() {
        return this.native.numDocs();
    }
}
