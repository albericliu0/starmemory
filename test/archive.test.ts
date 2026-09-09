import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archivePathFor, copyIfChanged, defaultArchiveRoot, readArchive, resolveArchivePath, summaryPathFor } from '../src/archive.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-archive-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('where a copy lives', () => {
  it('is root/harness/project/basename', () => {
    expect(archivePathFor('/a', 'codex', 'proj', '/x/y/rollout-1.jsonl')).toBe('/a/codex/proj/rollout-1.jsonl.gz');
    expect(archivePathFor('/a', 'codex', 'proj', '/x/y/rollout-1.jsonl.gz')).toBe('/a/codex/proj/rollout-1.jsonl.gz');
  });
  it('defaults under ~/.config/starmemory unless STARMEMORY_ARCHIVE_PATH says otherwise', () => {
    expect(defaultArchiveRoot({})).toBe(path.join(os.homedir(), '.config', 'starmemory', 'archive'));
    expect(defaultArchiveRoot({ STARMEMORY_ARCHIVE_PATH: '/tmp/x' })).toBe('/tmp/x');
  });
  it('names the summary beside the copy', () => {
    expect(summaryPathFor('/a/claude/p/s1.jsonl.gz')).toBe('/a/claude/p/s1-summary.txt');
    expect(summaryPathFor('/a/claude/p/s1.jsonl')).toBe('/a/claude/p/s1-summary.txt');
  });
});

describe('copyIfChanged', () => {
  it('writes a gzipped copy, creating directories, and reports it', async () => {
    const src = path.join(dir, 'src.jsonl'); fs.writeFileSync(src, 'one\n');
    const dest = path.join(dir, 'root', 'claude', 'p', 'src.jsonl.gz');
    expect(await copyIfChanged(src, dest)).toBe(true);
    expect(readArchive(dest)).toBe('one\n');
    expect(fs.readFileSync(dest)[0]).toBe(0x1f); // gzip magic
  });
  it('skips an unchanged file and copies again once the source is touched', async () => {
    const src = path.join(dir, 'src.jsonl'); fs.writeFileSync(src, 'one\n');
    const dest = path.join(dir, 'dest.jsonl.gz');
    await copyIfChanged(src, dest);
    expect(await copyIfChanged(src, dest)).toBe(false);
    fs.appendFileSync(src, 'two\n');
    const later = new Date(Date.now() + 2000); fs.utimesSync(src, later, later);
    expect(await copyIfChanged(src, dest)).toBe(true);
    expect(readArchive(dest)).toBe('one\ntwo\n');
  });
  it('keeps the source mtime on the copy, so quiet-period checks can read either', async () => {
    const src = path.join(dir, 'src.jsonl'); fs.writeFileSync(src, 'one\n');
    const then = new Date(Date.now() - 5 * 60 * 60 * 1000); fs.utimesSync(src, then, then);
    const dest = path.join(dir, 'dest.jsonl.gz');
    await copyIfChanged(src, dest);
    expect(Math.abs(fs.statSync(dest).mtimeMs - then.getTime())).toBeLessThan(1000);
  });
  it('leaves no temp file behind', async () => {
    const src = path.join(dir, 'src.jsonl'); fs.writeFileSync(src, 'one\n');
    await copyIfChanged(src, path.join(dir, 'out', 'src.jsonl.gz'));
    expect(fs.readdirSync(path.join(dir, 'out'))).toEqual(['src.jsonl.gz']);
  });
});

describe('resolveArchivePath', () => {
  it('returns the stored path while the source still exists', () => {
    const src = path.join(dir, 'p', 's1.jsonl'); fs.mkdirSync(path.dirname(src)); fs.writeFileSync(src, '');
    expect(resolveArchivePath(path.join(dir, 'root'), src, 'claude', 'p')).toBe(src);
  });
  it('falls back to the archive copy once the source is gone', () => {
    const root = path.join(dir, 'root');
    const copy = path.join(root, 'claude', 'p', 's1.jsonl.gz'); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.writeFileSync(copy, '');
    expect(resolveArchivePath(root, path.join(dir, 'gone', 's1.jsonl'), 'claude', 'p')).toBe(copy);
  });
  it('hands back the stored path when neither exists, so the caller can say so', () => {
    const stored = path.join(dir, 'gone', 's1.jsonl');
    expect(resolveArchivePath(path.join(dir, 'root'), stored, 'claude', 'p')).toBe(stored);
  });
});
