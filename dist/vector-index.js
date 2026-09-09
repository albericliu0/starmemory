// HNSW vector search -- design doc §07.
//
// Backed by usearch inside the single Rust addon. The index file is a
// rebuildable cache, not source of truth: that is `vectors` in store.ts. On
// open() we load the file if it is there and usable, otherwise we rebuild from
// every vector in LMDB.
//
// A rebuild never touches the file a reader may have mapped. It writes the next
// generation (`index-v2.g7.hnsw` after `index-v2.g6.hnsw`) and records that
// number in LMDB meta; a reader switches when it sees the number change. That
// is the one mechanism on every platform: Windows refuses to replace or delete
// a mapped file, so the POSIX rename trick was never going to travel (design
// doc windows-support §07).
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDING_DIM } from './embeddings.js';
import { allVectors } from './store.js';
import { addon } from './addon.js';
/** LMDB meta key holding the generation readers should be on. */
export const VECTOR_GENERATION_KEY = 'vector_index_generation';
/** The addon generation is spliced into the file name: `index.hnsw` becomes
 * `index-v2.hnsw`. Two builds with different on-disk layouts then never read
 * each other's file (design doc §10, as for the text index directory). This
 * is the pre-generation name; see generationPath for what is written now. */
export function versionedVectorIndexPath(basePath) {
    const ext = path.extname(basePath);
    const stem = basePath.slice(0, basePath.length - ext.length);
    return `${stem}-v${addon().vectorIndexVersion()}${ext}`;
}
/** `index.hnsw` + generation 3 -> `index-v2.g3.hnsw`. */
export function generationPath(basePath, generation) {
    const ext = path.extname(basePath);
    const stem = basePath.slice(0, basePath.length - ext.length);
    return `${stem}-v${addon().vectorIndexVersion()}.g${generation}${ext}`;
}
/** The generation the store says is current, or undefined before the first build. */
export function currentGeneration(store) {
    const raw = store.meta.get(VECTOR_GENERATION_KEY);
    if (raw === undefined || raw === null)
        return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}
/** Delete the file a build older than versionedVectorIndexPath left at the
 * bare base path. It is a cache, so nothing is lost. */
export function removeLegacyVectorIndex(basePath) {
    try {
        if (!fs.statSync(basePath).isFile())
            return false;
    }
    catch {
        return false;
    }
    fs.rmSync(basePath, { force: true });
    return true;
}
/** How long another generation's file may go unwritten before it is pruned.
 * A build that is still in use rewrites its file on every sync that indexes
 * something, so an old mtime means an abandoned generation. */
export const VECTOR_INDEX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Files that belong to this index family: `<stem>-v<N>.hnsw` (legacy) and
 * `<stem>-v<N>.g<G>.hnsw`. */
function familyPattern(basePath) {
    const ext = path.extname(basePath);
    const stem = path.basename(basePath, ext);
    return new RegExp(`^${escapeRegExp(stem)}-v\\d+(?:\\.g\\d+)?${escapeRegExp(ext)}$`);
}
function listFamily(basePath) {
    const parent = path.dirname(basePath);
    const pattern = familyPattern(basePath);
    try {
        return fs
            .readdirSync(parent, { withFileTypes: true })
            .filter((e) => e.isFile() && pattern.test(e.name))
            .map((e) => path.join(parent, e.name));
    }
    catch {
        return [];
    }
}
/** Remove other generations of the current version. Best effort: on Windows a
 * file another process still maps cannot be deleted, so the next rebuild tries
 * again. Returns what was removed. */
export function sweepOtherGenerations(basePath, keep) {
    const mine = generationPath(basePath, keep);
    const version = addon().vectorIndexVersion();
    const ext = path.extname(basePath);
    const stem = path.basename(basePath, ext);
    const sameVersion = new RegExp(`^${escapeRegExp(stem)}-v${version}(?:\\.g\\d+)?${escapeRegExp(ext)}$`);
    const removed = [];
    for (const file of listFamily(basePath)) {
        if (file === mine || !sameVersion.test(path.basename(file)))
            continue;
        try {
            fs.rmSync(file, { force: true });
            removed.push(file);
        }
        catch {
            // mapped by another process (Windows), or already gone
        }
    }
    return removed;
}
/** Remove other *versions'* index files that have sat idle. Never touches the
 * current version's files, nor anything not shaped like a sibling of ours.
 * Returns the paths removed. */
export function pruneStaleVectorIndexFiles(basePath, { now = Date.now(), maxIdleMs = VECTOR_INDEX_IDLE_MS } = {}) {
    const version = addon().vectorIndexVersion();
    const ext = path.extname(basePath);
    const stem = path.basename(basePath, ext);
    const sameVersion = new RegExp(`^${escapeRegExp(stem)}-v${version}(?:\\.g\\d+)?${escapeRegExp(ext)}$`);
    const removed = [];
    for (const candidate of listFamily(basePath)) {
        if (sameVersion.test(path.basename(candidate)))
            continue;
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(candidate).mtimeMs;
        }
        catch {
            continue;
        }
        if (now - mtimeMs <= maxIdleMs)
            continue;
        try {
            fs.rmSync(candidate, { force: true });
            removed.push(candidate);
        }
        catch {
            // Another process may have got there first.
        }
    }
    return removed;
}
const DEFAULT_OPTIONS = {
    dim: EMBEDDING_DIM,
    connectivity: 16,
    expansionAdd: 40,
    expansionSearch: 64,
};
function toNative(options) {
    return {
        dim: options.dim,
        connectivity: options.connectivity,
        expansionAdd: options.expansionAdd,
        expansionSearch: options.expansionSearch,
    };
}
export class VectorIndex {
    store;
    basePath;
    options;
    searcher = null;
    /** The generation `searcher` was opened from. */
    opened = null;
    /** A generation we tried and failed to open. Not retried until the store
     * names another one, so one bad file does not cost a failed open per search. */
    rejected = null;
    constructor(store, basePath, options) {
        this.store = store;
        this.basePath = basePath;
        this.options = options;
    }
    /** `basePath` is the unversioned name, `~/.config/starmemory/index.hnsw`;
     * the file actually used is generationPath(basePath, currentGeneration). */
    static open(store, basePath, options = {}) {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        removeLegacyVectorIndex(basePath);
        const index = new VectorIndex(store, basePath, opts);
        let generation = currentGeneration(store);
        if (generation === undefined) {
            // A store from before generations: its one file becomes g0 if we can
            // move it (nobody has it mapped at this point on POSIX; on Windows a
            // failed rename just means a rebuild).
            const legacy = versionedVectorIndexPath(basePath);
            if (fs.existsSync(legacy)) {
                try {
                    fs.renameSync(legacy, generationPath(basePath, 0));
                    store.meta.putSync(VECTOR_GENERATION_KEY, '0');
                    generation = 0;
                }
                catch {
                    // fall through to a rebuild
                }
            }
        }
        if (generation === undefined) {
            index.rebuild(store);
        }
        else {
            try {
                index.openSearcher(generation);
            }
            catch {
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
    rebuild(store) {
        const { ids, flat } = allVectors(store, this.options.dim);
        const next = (currentGeneration(store) ?? -1) + 1;
        const file = generationPath(this.basePath, next);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        addon().buildVectorIndex(toNative(this.options), Float64Array.from(ids), flat, file);
        store.meta.putSync(VECTOR_GENERATION_KEY, String(next));
        this.openSearcher(next);
        sweepOtherGenerations(this.basePath, next);
    }
    openSearcher(generation) {
        const next = addon().VectorSearcher.open(toNative(this.options), generationPath(this.basePath, generation));
        this.searcher?.close();
        this.searcher = next;
        this.opened = generation;
        this.rejected = null;
    }
    /** Switch to the generation the store names if it is not the one we have. A
     * reader keeps its old graph until then; the old file stays on disk at least
     * until we let go of it, so an unreadable replacement leaves the current
     * searcher in place.
     *
     * Called by the query layer once per query, not per search(): a multi-concept
     * query runs several searches and they must all see one graph. */
    refresh() {
        if (!this.searcher)
            return;
        const current = currentGeneration(this.store);
        if (current === undefined || current === this.opened || current === this.rejected)
            return;
        try {
            this.openSearcher(current);
        }
        catch (error) {
            // Incompatible or damaged file: keep answering from the old graph.
            this.rejected = current;
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`starmemory: vector index generation ${current} cannot be opened (${reason}); still using generation ${this.opened}\n`);
        }
    }
    /** The file the current searcher was opened from. */
    get currentPath() {
        return this.opened === null ? null : generationPath(this.basePath, this.opened);
    }
    /** Top-k by cosine similarity, optionally restricted to `filterIds`.
     *
     * The filter runs inside the graph traversal, so a filtered query does not
     * over-fetch and trim (design doc §07/§08). */
    search(query, k, filterIds) {
        if (!this.searcher)
            return [];
        return this.searcher.search(query, k, filterIds ? Float64Array.from(filterIds) : null);
    }
    /** Vectors currently in the graph. */
    size() {
        return this.searcher ? this.searcher.len() : 0;
    }
}
