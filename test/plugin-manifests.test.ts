// The two harness manifests must describe the same plugin: one hooks file, one
// MCP server, one store (design doc §16). Codex resolves relative paths against
// the plugin root and does not set CLAUDE_PLUGIN_ROOT, so anything Codex reads
// has to be relative.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));

describe('Codex plugin manifest', () => {
  const manifest = () => read('.codex-plugin/plugin.json');

  it('exists and names the same plugin as the Claude Code manifest', () => {
    expect(manifest().name).toBe(read('.claude-plugin/plugin.json').name);
    expect(manifest().version).toBe(read('.claude-plugin/plugin.json').version);
  });

  it('points at the hooks file and the MCP config, and both exist', () => {
    const m = manifest();
    expect(fs.existsSync(path.join(root, m.hooks))).toBe(true);
    expect(fs.existsSync(path.join(root, m.mcpServers))).toBe(true);
  });

  it('shares the hooks file with Claude Code, so a sync is one command in both', () => {
    expect(manifest().hooks).toBe('./hooks/hooks.json');
  });
});

describe('.mcp.json (read by Codex)', () => {
  const server = () => read('.mcp.json').mcpServers.starmemory;

  it('uses paths relative to the plugin root, never CLAUDE_PLUGIN_ROOT', () => {
    const s = server();
    expect(s.cwd).toBe('.');
    for (const arg of s.args) {
      expect(arg).not.toContain('CLAUDE_PLUGIN_ROOT');
      expect(fs.existsSync(path.join(root, arg))).toBe(true);
    }
  });

  it('launches the same server the Claude Code manifest does', () => {
    const claude = read('.claude-plugin/plugin.json').mcpServers.starmemory;
    const strip = (a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}/', './');
    expect(server().command).toBe(claude.command);
    expect(server().args).toEqual(claude.args.map(strip));
  });
});

describe('hooks.json', () => {
  it('resolves the plugin root through PLUGIN_ROOT first, which is the name Codex sets', () => {
    const hooks = read('hooks/hooks.json').hooks.SessionStart;
    for (const group of hooks) {
      for (const h of group.hooks) expect(h.command).toContain('${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}');
    }
  });

  it('also fires after a compaction, so a session that runs for days is synced at each compact', () => {
    const hooks = read('hooks/hooks.json').hooks.SessionStart;
    for (const group of hooks) {
      expect(group.matcher.split('|')).toEqual(expect.arrayContaining(['startup', 'resume', 'clear', 'compact']));
    }
  });
});

describe('local Codex marketplace', () => {
  it('lists this directory as the plugin source', () => {
    const m = read('.agents/plugins/marketplace.json');
    expect(m.plugins[0].name).toBe('starmemory');
    expect(m.plugins[0].source.url).toBe('./');
  });
});
