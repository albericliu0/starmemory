// Loader for the single Rust native addon.
//
// One module now covers both retrieval paths: Tantivy BM25 (engine.rs) and
// usearch HNSW (vector.rs). It replaces the earlier split between a vendored
// C++ faiss/tenann addon and a separate Rust one -- one crate, one toolchain,
// and no external OpenMP runtime to locate at load time.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
/** Built by `npm run build:native`. `dist/` and `src/` sit at the same depth
 * relative to the crate, so one relative path serves both. */
export const ADDON_PATH = path.resolve(here, '..', 'native', 'starmemory_native.node');
let cached = null;
export function isAddonAvailable() {
    return fs.existsSync(ADDON_PATH);
}
export function addon() {
    if (!cached) {
        if (!fs.existsSync(ADDON_PATH)) {
            throw new Error(`starmemory native addon not found at ${ADDON_PATH} -- run "npm run build:native"`);
        }
        cached = require(ADDON_PATH);
    }
    return cached;
}
