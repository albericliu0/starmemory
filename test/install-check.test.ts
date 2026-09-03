// Pre-flight checks that run BEFORE npm dependencies exist, so they live in
// plain .mjs under cli/ and may not import anything from node_modules.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain JS module, no type declarations by design
import {
  RUNTIME_DEPENDENCIES,
  findMissingDeps,
  findMissingAddons,
  isSupportedPlatform,
  unsupportedPlatformMessage,
} from '../cli/install-check.mjs';

let root: string;

function writePackage(name: string, { manifest = true } = {}) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
}

function writeAddon(relative: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'binary');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-preflight-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('findMissingDeps', () => {
  it('reports every runtime dependency when node_modules is absent', () => {
    expect(findMissingDeps(root)).toEqual([...RUNTIME_DEPENDENCIES]);
  });

  it('reports nothing once every dependency is installed', () => {
    for (const name of RUNTIME_DEPENDENCIES) writePackage(name);

    expect(findMissingDeps(root)).toEqual([]);
  });

  it('reports only the dependency that is missing', () => {
    for (const name of RUNTIME_DEPENDENCIES) if (name !== 'lmdb') writePackage(name);

    expect(findMissingDeps(root)).toEqual(['lmdb']);
  });

  it('treats a package folder with no manifest as missing', () => {
    // A half-extracted package would slip past a bare existsSync on the folder
    // and then crash the server with ERR_MODULE_NOT_FOUND after handoff.
    for (const name of RUNTIME_DEPENDENCIES) writePackage(name);
    fs.rmSync(path.join(root, 'node_modules', 'lmdb', 'package.json'));

    expect(findMissingDeps(root)).toEqual(['lmdb']);
  });
});

describe('findMissingAddons', () => {
  const BOTH = [
    'native/build/Release/starmemory_native.node',
    'native-text/starmemory_text.node',
  ];

  it('reports both native addons when neither has been built', () => {
    expect(findMissingAddons(root)).toEqual(BOTH);
  });

  it('reports nothing once both are present', () => {
    for (const relative of BOTH) writeAddon(relative);

    expect(findMissingAddons(root)).toEqual([]);
  });

  it('reports the one that is missing', () => {
    writeAddon(BOTH[0]);

    expect(findMissingAddons(root)).toEqual([BOTH[1]]);
  });
});

describe('isSupportedPlatform', () => {
  it('accepts an Apple Silicon Mac, which is what this build ships for', () => {
    expect(isSupportedPlatform('darwin', 'arm64')).toBe(true);
  });

  it('rejects an Intel Mac, because the addons are arm64 only', () => {
    expect(isSupportedPlatform('darwin', 'x64')).toBe(false);
  });

  it('rejects Linux and Windows', () => {
    expect(isSupportedPlatform('linux', 'x64')).toBe(false);
    expect(isSupportedPlatform('win32', 'x64')).toBe(false);
  });
});

describe('unsupportedPlatformMessage', () => {
  it('names the platform it actually found, so the reason is obvious', () => {
    const message = unsupportedPlatformMessage('linux', 'x64');

    expect(message).toContain('linux-x64');
    expect(message).toContain('darwin-arm64');
  });

  it('says how to proceed rather than only what failed', () => {
    expect(unsupportedPlatformMessage('darwin', 'x64')).toMatch(/build|编译|npm run build/i);
  });
});
