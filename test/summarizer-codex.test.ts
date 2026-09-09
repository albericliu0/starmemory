import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeWithCodex, parseCodexVersion, versionAtLeast } from '../src/summarizer-codex.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-app-server.mjs');
const bin = `${process.execPath} ${fake}`;

describe('version gate', () => {
  it('parses and compares', () => {
    expect(parseCodexVersion('codex-cli 0.131.2')).toBe('0.131.2');
    expect(versionAtLeast('0.131.2')).toBe(true);
    expect(versionAtLeast('0.129.9')).toBe(false);
    expect(versionAtLeast('1.0.0')).toBe(true);
  });
  it('refuses an old codex with a message that says what to do', async () => {
    await expect(summarizeWithCodex({ threadId: 't', transcript: '' }, { bin, env: { FAKE_CODEX_VERSION: '0.120.0' } }))
      .rejects.toThrow(/requires codex-cli >= 0\.130\.0; found 0\.120\.0/);
  });
});

describe('summarizeWithCodex', () => {
  it('forks the original thread and returns the agent message', async () => {
    const text = await summarizeWithCodex({ threadId: 'abc', transcript: 'User: hi' }, { bin, env: {} });
    expect(text).toBe('The user fixed a race.');
  });
  it('starts a fresh thread with the transcript when the fork fails', async () => {
    const text = await summarizeWithCodex({ threadId: 'gone', transcript: 'User: hi\nAssistant: yo' }, { bin, env: { FAKE_CODEX_MODE: 'fork-fails' } });
    expect(text).toBe('From transcript text.');
  });
  it('reports a failed turn', async () => {
    await expect(summarizeWithCodex({ threadId: 'abc', transcript: '' }, { bin, env: { FAKE_CODEX_MODE: 'turn-fails' } }))
      .rejects.toThrow(/model unavailable/);
  });
  it('gives up after the timeout', async () => {
    await expect(summarizeWithCodex({ threadId: 'abc', transcript: '' }, { bin, env: { FAKE_CODEX_MODE: 'hang' }, timeoutMs: 300 }))
      .rejects.toThrow(/timed out/);
  });
  it('reports a missing codex binary plainly', async () => {
    await expect(summarizeWithCodex({ transcript: '' }, { bin: path.join(path.dirname(fake), 'no-such-codex'), env: {} }))
      .rejects.toThrow(/codex not found/);
  });
});
