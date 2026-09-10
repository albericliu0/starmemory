// Design doc windows-support §04: only the darwin-arm64 addon is committed;
// every other platform's binary is a release asset fetched on first run. It is
// native code loaded into our own process, so it is verified against the
// release's SHA256SUMS and only ever fetched over https (or loopback http, here).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain JS module, no type declarations by design
import { addonDownloadUrl, addonChecksumsUrl, checkedAddonBaseUrl, expectedDigest, DEFAULT_ADDON_BASE_URL } from '../cli/install-check.mjs';
// @ts-expect-error -- plain JS module, no type declarations by design
import { downloadAddon } from '../cli/bootstrap.mjs';

let root: string;
let server: http.Server;
let base: string;
const body = Buffer.from('pretend this is a .node file');
const digest = createHash('sha256').update(body).digest('hex');
let responses: Record<string, { status: number; body: string | Buffer }>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-addon-dl-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'starmemory', version: '9.9.9' }));
  responses = {
    '/dl/v9.9.9/SHA256SUMS': { status: 200, body: `${digest}  starmemory_native.linux-x64.node\n${'0'.repeat(64)}  starmemory_native.win32-x64.node\n` },
    '/dl/v9.9.9/starmemory_native.linux-x64.node': { status: 200, body },
    '/dl/v9.9.9/starmemory_native.win32-x64.node': { status: 200, body },
  };
  server = http.createServer((req, res) => {
    const r = responses[req.url ?? ''] ?? { status: 404, body: 'nope' };
    res.statusCode = r.status;
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}/dl`;
  process.env.STARMEMORY_ADDON_BASE_URL = base;
});

afterEach(async () => {
  delete process.env.STARMEMORY_ADDON_BASE_URL;
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('release URLs', () => {
  it('point at the asset and the checksum file for the version and platform', () => {
    expect(addonDownloadUrl('0.4.0', 'linux-x64', DEFAULT_ADDON_BASE_URL)).toBe(`${DEFAULT_ADDON_BASE_URL}/v0.4.0/starmemory_native.linux-x64.node`);
    expect(addonChecksumsUrl('0.4.0', 'https://mirror.example/r/')).toBe('https://mirror.example/r/v0.4.0/SHA256SUMS');
  });

  it('refuse anything but https, except http to the local machine', () => {
    expect(checkedAddonBaseUrl('https://example.com/x/')).toBe('https://example.com/x');
    expect(checkedAddonBaseUrl('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(() => checkedAddonBaseUrl('http://mirror.example/x')).toThrow(/must be https/);
    expect(() => checkedAddonBaseUrl('ftp://mirror.example/x')).toThrow(/must be https/);
  });

  it('read a sha256sum-style checksum file', () => {
    const sums = `${digest}  starmemory_native.linux-x64.node\nabc  not-a-digest\n`;
    expect(expectedDigest(sums, 'starmemory_native.linux-x64.node')).toBe(digest);
    expect(expectedDigest(sums, 'starmemory_native.win32-x64.node')).toBeUndefined();
  });
});

describe('downloadAddon', () => {
  it('saves a verified asset at the platform path and leaves no partial file', async () => {
    const lines: string[] = [];

    const target = await downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: (l: string) => lines.push(l) });

    expect(target).toBe(path.join(root, 'native', 'starmemory_native.linux-x64.node'));
    expect(fs.readFileSync(target)).toEqual(body);
    expect(fs.readdirSync(path.join(root, 'native'))).toEqual(['starmemory_native.linux-x64.node']);
    expect(lines.join('\n')).toContain('sha256 verified');
  });

  it('refuses a binary whose checksum does not match, and writes nothing', async () => {
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'win32-x64', log: () => {} })).rejects.toThrow(/does not match the release checksum/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
  });

  it('refuses a binary the checksum file does not list', async () => {
    responses['/dl/v9.9.9/SHA256SUMS'] = { status: 200, body: 'nothing here\n' };
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {} })).rejects.toThrow(/no entry for starmemory_native.linux-x64.node/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
  });

  it('fails with the URL in the message when the release has no such asset', async () => {
    delete responses['/dl/v9.9.9/starmemory_native.linux-x64.node'];
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {} })).rejects.toThrow(/HTTP 404 .*v9\.9\.9\/starmemory_native\.linux-x64\.node/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
  });

  it('never fetches native code from a plain-http host', async () => {
    process.env.STARMEMORY_ADDON_BASE_URL = 'http://mirror.example/dl';
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {} })).rejects.toThrow(/must be https/);
  });
});
