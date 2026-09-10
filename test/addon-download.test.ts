// Design doc windows-support §04: only the darwin-arm64 addon is committed;
// every other platform's binary is a release asset fetched on first run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain JS module, no type declarations by design
import { addonDownloadUrl, DEFAULT_ADDON_BASE_URL } from '../cli/install-check.mjs';
// @ts-expect-error -- plain JS module, no type declarations by design
import { downloadAddon } from '../cli/bootstrap.mjs';

let root: string;
let server: http.Server;
let base: string;
let status = 200;
const body = Buffer.from('pretend this is a .node file');

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-addon-dl-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'starmemory', version: '9.9.9' }));
  status = 200;
  server = http.createServer((req, res) => {
    res.statusCode = status;
    res.end(status === 200 ? body : 'nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}/dl`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('addonDownloadUrl', () => {
  it('points at the release asset for the version and platform', () => {
    expect(addonDownloadUrl('0.4.0', 'linux-x64')).toBe(`${DEFAULT_ADDON_BASE_URL}/v0.4.0/starmemory_native.linux-x64.node`);
    expect(addonDownloadUrl('0.4.0', 'win32-x64', 'https://mirror.example/r/')).toBe('https://mirror.example/r/v0.4.0/starmemory_native.win32-x64.node');
  });
});

describe('downloadAddon', () => {
  it('saves the asset at the platform path and leaves no partial file', async () => {
    process.env.STARMEMORY_ADDON_BASE_URL = base;
    const lines: string[] = [];

    const target = await downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: (l: string) => lines.push(l) });

    expect(target).toBe(path.join(root, 'native', 'starmemory_native.linux-x64.node'));
    expect(fs.readFileSync(target)).toEqual(body);
    expect(fs.readdirSync(path.join(root, 'native'))).toEqual(['starmemory_native.linux-x64.node']);
    expect(lines.join('\n')).toContain('v9.9.9/starmemory_native.linux-x64.node');
    delete process.env.STARMEMORY_ADDON_BASE_URL;
  });

  it('fails with the URL in the message and writes nothing when the asset is missing', async () => {
    process.env.STARMEMORY_ADDON_BASE_URL = base;
    status = 404;

    await expect(downloadAddon(root, { version: '9.9.9', tag: 'win32-x64', log: () => {} })).rejects.toThrow(/HTTP 404 .*v9\.9\.9\/starmemory_native\.win32-x64\.node/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
    delete process.env.STARMEMORY_ADDON_BASE_URL;
  });
});
