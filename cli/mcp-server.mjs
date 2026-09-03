#!/usr/bin/env node
// MCP entry point named by .claude-plugin/plugin.json. Ensures the plugin can
// actually run, then hands off to the compiled server.
import { ensureReady, handOff } from './bootstrap.mjs';

if (!(await ensureReady())) {
  process.stderr.write('starmemory: not starting the MCP server (see above).\n');
  process.exit(1);
}

handOff('dist/mcp-server.js');
