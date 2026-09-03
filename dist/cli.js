#!/usr/bin/env node
// CLI entry -- `starmemory sync`, `starmemory search <query>`, `starmemory mcp-server`.
// Mirrors episodic-memory's cli/ commands closely enough that hooks.json needs
// no restructuring beyond swapping the invoked script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './store.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex, isTextIndexAvailable } from './text-index.js';
import { syncAll } from './sync.js';
import { search } from './search.js';
const DB_PATH = process.env.STARMEMORY_DB_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'store.mdb');
const INDEX_PATH = process.env.STARMEMORY_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'index.hnsw');
const TEXT_INDEX_PATH = process.env.STARMEMORY_TEXT_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'text');
function openEngine() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const store = openStore(DB_PATH);
    const index = VectorIndex.open(store, INDEX_PATH);
    // Without the compiled addon the engine still works, on the substring fallback.
    const textIndex = isTextIndexAvailable() ? TextIndex.open(TEXT_INDEX_PATH) : undefined;
    return { store, index, textIndex };
}
async function main() {
    const [, , command, ...rest] = process.argv;
    if (command === 'sync') {
        const background = rest.includes('--background');
        const { store, index, textIndex } = openEngine();
        try {
            const result = await syncAll(store, index, undefined, textIndex);
            if (!background) {
                const bm25 = result.textSkipped
                    ? 'BM25 index left to another running sync'
                    : `${result.textIndexed} added to the BM25 index`;
                console.log(`Scanned ${result.filesScanned} files, indexed ${result.exchangesIndexed} new exchanges, ${bm25}.`);
            }
        }
        finally {
            await store.close();
        }
        return;
    }
    if (command === 'search') {
        const query = rest.join(' ');
        if (!query) {
            console.error('Usage: starmemory search <query>');
            process.exit(1);
        }
        const { store, index, textIndex } = openEngine();
        try {
            const results = await search(store, index, query, { limit: 10 }, textIndex);
            for (const [i, r] of results.entries()) {
                const pct = r.similarity !== undefined ? ` (${Math.round(r.similarity * 100)}%)` : '';
                console.log(`${i + 1}. [${r.exchange.project}]${pct} ${r.snippet}`);
            }
            if (results.length === 0)
                console.log('No results found.');
        }
        finally {
            await store.close();
        }
        return;
    }
    if (command === 'mcp-server') {
        await import('./mcp-server.js');
        return;
    }
    console.error('Usage: starmemory <sync [--background] | search <query> | mcp-server>');
    process.exit(1);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
