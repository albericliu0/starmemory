#!/usr/bin/env node
// Build the Rust addon for the platform this runs on and place it where
// addon.ts looks: native/starmemory_native.<platform>-<arch>.node.
//
// A Node script rather than a shell one-liner because npm runs package.json
// scripts through cmd.exe on Windows, where `PATH="..." cargo ...` is not an
// environment prefix but an assignment that wipes PATH (design doc
// windows-support §05: the first CI run failed exactly there).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'native');

// rustup installs to ~/.cargo/bin without touching PATH when asked not to;
// prepend it so a plain `npm run build:native` works on such a machine.
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}` };

execFileSync('cargo', ['build', '--release'], { cwd: native, env, stdio: 'inherit' });

const built =
  process.platform === 'win32'
    ? path.join(native, 'target', 'release', 'starmemory_native.dll')
    : process.platform === 'darwin'
      ? path.join(native, 'target', 'release', 'libstarmemory_native.dylib')
      : path.join(native, 'target', 'release', 'libstarmemory_native.so');
const target = path.join(native, `starmemory_native.${process.platform}-${process.arch}.node`);
fs.copyFileSync(built, target);
console.log(`built ${path.relative(root, target)} (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
