#!/usr/bin/env node
// MCP server -- design doc §09 "与 Claude Code 集成". Exposes the same two
// tools as episodic-memory (search, read) so it's a drop-in replacement from
// the Claude Code side: hooks.json and tool schemas don't need to change.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './store.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex, isTextIndexAvailable } from './text-index.js';
import { search, searchMultipleConcepts } from './search.js';
const DB_PATH = process.env.STARMEMORY_DB_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'store.mdb');
const INDEX_PATH = process.env.STARMEMORY_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'index.hnsw');
const TEXT_INDEX_PATH = process.env.STARMEMORY_TEXT_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'text');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const store = openStore(DB_PATH);
const index = VectorIndex.open(store, INDEX_PATH);
// Read-only here: the MCP server never writes the index, sync does. Several
// server processes reading the same directory is fine, tantivy readers are
// snapshot-based and take no lock (design doc §09).
const textIndex = isTextIndexAvailable() ? TextIndex.open(TEXT_INDEX_PATH) : undefined;
function formatResults(results) {
    if (results.length === 0)
        return 'No results found.';
    return results
        .map((r, i) => {
        const date = r.exchange.timestamp.slice(0, 10);
        const pct = r.similarity !== undefined ? ` - ${Math.round(r.similarity * 100)}% match` : '';
        return `${i + 1}. [${r.exchange.project}, ${date}]${pct}\n   "${r.snippet}"\n   Lines ${r.exchange.lineStart}-${r.exchange.lineEnd} in ${r.exchange.archivePath}\n`;
    })
        .join('\n');
}
function formatMultiConceptResults(results, concepts) {
    if (results.length === 0)
        return `No conversations found matching all concepts: ${concepts.join(', ')}`;
    return results
        .map((r, i) => {
        const date = r.exchange.timestamp.slice(0, 10);
        const scores = r.conceptSimilarities.map((s, j) => `${concepts[j]}: ${Math.round(s * 100)}%`).join(', ');
        return `${i + 1}. [${r.exchange.project}, ${date}] - ${Math.round(r.averageSimilarity * 100)}% avg match\n   Concepts: ${scores}\n   "${r.snippet}"\n`;
    })
        .join('\n');
}
const server = new McpServer({ name: 'starmemory', version: '0.1.0' });
server.registerTool('search', {
    title: 'Search Memory',
    description: 'Search past Claude Code conversations by semantic similarity, exact text, or both. ' +
        'Pass a single string for semantic search, or an array of 2-5 concepts for AND matching.',
    inputSchema: {
        query: z.union([z.string().min(2), z.array(z.string().min(2)).min(2).max(5)]),
        mode: z.enum(['vector', 'text', 'hybrid', 'both']).default('hybrid'),
        limit: z.number().int().min(1).max(50).default(10),
        after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        project: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
    },
}, async ({ query, mode, limit, after, before, project, sessionId }) => {
    const text = Array.isArray(query)
        ? formatMultiConceptResults(await searchMultipleConcepts(store, index, query, { limit, project, sessionId }), query)
        : formatResults(await search(store, index, query, { mode, limit, after, before, project, sessionId }, textIndex));
    return { content: [{ type: 'text', text }] };
});
server.registerTool('read', {
    title: 'Read Full Conversation',
    description: 'Read a full conversation transcript from its archive JSONL file.',
    inputSchema: {
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
    },
}, async ({ path: filePath, startLine, endLine }) => {
    if (!fs.existsSync(filePath)) {
        return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const start = (startLine ?? 1) - 1;
    const end = endLine ?? lines.length;
    const text = lines.slice(start, end).join('\n');
    return { content: [{ type: 'text', text }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
