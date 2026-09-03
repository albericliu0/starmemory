#!/usr/bin/env node
// Produce exactly what a marketplace install would deliver.
//
// `git archive` is the point: it emits the tracked files and nothing else, so
// the package cannot accidentally carry node_modules, the 821 MB vendored
// faiss/tenann tree, or the 1.7 GB Rust target dir. Installing from a local
// *directory* copies the tree verbatim and ignores .gitignore, which is how a
// 24 MB plugin turns into a 3 GB one.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build-pkg');
const stageDir = path.join(outDir, 'starmemory');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'pipe', ...opts });

if (run('git', ['status', '--porcelain']).toString().trim()) {
  console.error('Refusing to package: the working tree has uncommitted changes.');
  console.error('git archive ships HEAD, so the package would not match your files.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

// A shell pipeline rather than passing a multi-megabyte Buffer through Node.
execSync(`git archive --format=tar HEAD | tar -x -C "${stageDir}"`, { cwd: root, stdio: 'pipe' });

const zipPath = path.join(outDir, 'starmemory.zip');
execFileSync('zip', ['-qr', zipPath, 'starmemory'], { cwd: outDir, stdio: 'pipe' });

const kb = (p) => Number(run('du', ['-sk', p]).toString().split(/\s+/)[0]);
const mb = (n) => `${(n / 1024).toFixed(1)} MB`;
const fileCount = run('git', ['ls-files']).toString().trim().split('\n').length;

console.log(`packaged ${fileCount} tracked files`);
console.log(`  directory  ${stageDir}  (${mb(kb(stageDir))})`);
console.log(`  zip        ${zipPath}  (${mb(kb(zipPath))})`);
console.log('');
console.log('Install with either:');
console.log(`  claude plugin marketplace add ${stageDir}`);
console.log(`  claude plugin install starmemory@starmemory-marketplace -y`);
console.log('or, without installing:');
console.log(`  claude --plugin-dir ${zipPath}`);
