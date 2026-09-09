// The archive: starmemory's own copy of every transcript it has indexed.
// Claude Code deletes session files after cleanupPeriodDays (30 by default),
// so without a copy the index would outlive the text it points at. Design doc
// archive-and-summaries §03.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { Harness } from './types.js';

/** Archive copies are gzipped: a Claude Code transcript shrinks to roughly a
 * tenth. Readers go through openArchive(), which undoes this transparently. */
export const ARCHIVE_SUFFIX = '.gz';

export function defaultArchiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.STARMEMORY_ARCHIVE_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'archive');
}

/** `<root>/<harness>/<project>/<basename>`: the source's own file name under
 * the harness and project it came from, so two harnesses never collide. */
export function archivePathFor(root: string, harness: Harness, project: string, sourcePath: string): string {
  const name = path.basename(sourcePath);
  return path.join(root, harness, project, name.endsWith(ARCHIVE_SUFFIX) ? name : `${name}${ARCHIVE_SUFFIX}`);
}

/** A readable stream of the transcript's lines, whether it is a plain source
 * file or a gzipped archive copy. */
export function openArchive(filePath: string): Readable {
  const raw = fs.createReadStream(filePath);
  return filePath.endsWith(ARCHIVE_SUFFIX) ? raw.pipe(zlib.createGunzip()) : raw;
}

/** The whole transcript as text; see openArchive. */
export function readArchive(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return (filePath.endsWith(ARCHIVE_SUFFIX) ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
}

/** Copy (gzipped) when the source's mtime differs from the copy's. Size cannot
 * be compared across the compression, and mtime alone is enough: Claude Code
 * touches the file on every appended line. The copy keeps the source mtime, so
 * "how long has this conversation been quiet" reads the same from either file.
 * Written beside and renamed in, so a reader never sees a half-written file.
 * Resolves to true when a copy was made. */
/** Two syncs in one process (tests race them) must not share a temp name. */
let copyCounter = 0;

export async function copyIfChanged(sourcePath: string, archivePath: string): Promise<boolean> {
  const src = fs.statSync(sourcePath);
  try {
    if (Math.abs(fs.statSync(archivePath).mtimeMs - src.mtimeMs) < 1) return false;
  } catch {
    // no copy yet
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const temp = `${archivePath}.${process.pid}.${copyCounter++}.tmp`;
  try {
    await pipeline(fs.createReadStream(sourcePath), zlib.createGzip(), fs.createWriteStream(temp));
    fs.utimesSync(temp, src.atime, src.mtime);
    fs.renameSync(temp, archivePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

/** Rows stored before the archive existed point at the source file. Prefer it
 * while it is there; once Claude Code has cleaned it up, use our copy. When
 * neither exists the stored path comes back, so the caller can say so. */
export function resolveArchivePath(root: string, storedPath: string, harness: Harness, project: string): string {
  if (fs.existsSync(storedPath)) return storedPath;
  const copy = archivePathFor(root, harness, project, storedPath);
  return fs.existsSync(copy) ? copy : storedPath;
}

/** `<name>.jsonl.gz` and `<name>.jsonl` both map to `<name>-summary.txt`. */
export function summaryPathFor(archivePath: string): string {
  let stem = archivePath;
  if (stem.endsWith(ARCHIVE_SUFFIX)) stem = stem.slice(0, -ARCHIVE_SUFFIX.length);
  if (stem.endsWith('.jsonl')) stem = stem.slice(0, -'.jsonl'.length);
  return `${stem}-summary.txt`;
}
