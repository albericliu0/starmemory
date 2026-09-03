// Live MCP protocol smoke test: spawns the actual mcp-server.js over stdio
// (exactly how Claude Code would), lists tools, and calls `search` for real.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-mcp-smoke-'));

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.resolve('dist/mcp-server.js')],
  env: {
    ...process.env,
    STARMEMORY_DB_PATH: path.join(tmpDir, 'store.mdb'),
    STARMEMORY_INDEX_PATH: path.join(tmpDir, 'index.hnsw'),
  },
});

const client = new Client({ name: 'smoke-test-client', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log(
  'Tools:',
  tools.tools.map((t) => t.name)
);
if (!tools.tools.some((t) => t.name === 'search') || !tools.tools.some((t) => t.name === 'read')) {
  console.error('FAIL: expected both search and read tools');
  process.exit(1);
}

const result = await client.callTool({ name: 'search', arguments: { query: 'hello world', limit: 5 } });
console.log('search() call result:', JSON.stringify(result, null, 2).slice(0, 300));

await client.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('MCP SMOKE TEST PASSED');
