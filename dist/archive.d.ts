import { Readable } from 'node:stream';
import type { Harness } from './types.js';
/** Archive copies are gzipped: a Claude Code transcript shrinks to roughly a
 * tenth. Readers go through openArchive(), which undoes this transparently. */
export declare const ARCHIVE_SUFFIX = ".gz";
export declare function defaultArchiveRoot(env?: NodeJS.ProcessEnv): string;
/** `<root>/<harness>/<project>/<basename>`: the source's own file name under
 * the harness and project it came from, so two harnesses never collide. */
export declare function archivePathFor(root: string, harness: Harness, project: string, sourcePath: string): string;
/** A readable stream of the transcript's lines, whether it is a plain source
 * file or a gzipped archive copy. */
export declare function openArchive(filePath: string): Readable;
/** The whole transcript as text; see openArchive. */
export declare function readArchive(filePath: string): string;
export declare function copyIfChanged(sourcePath: string, archivePath: string): Promise<boolean>;
/** Rows stored before the archive existed point at the source file. Prefer it
 * while it is there; once Claude Code has cleaned it up, use our copy. When
 * neither exists the stored path comes back, so the caller can say so. */
export declare function resolveArchivePath(root: string, storedPath: string, harness: Harness, project: string): string;
/** `<name>.jsonl.gz` and `<name>.jsonl` both map to `<name>-summary.txt`. */
export declare function summaryPathFor(archivePath: string): string;
