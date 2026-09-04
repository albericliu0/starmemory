#!/usr/bin/env node
// CLI entry point, and the one the SessionStart hook calls.
//
// `--background` really backgrounds now. Claude Code waits for a SessionStart
// hook to exit, and a first sync with a real embedding model takes tens of
// seconds, so the hook process forks the work into a detached child and
// returns at once -- the same shape episodic-memory uses. The child writes to
// a log file instead of the hook's stdio, which Claude Code would otherwise
// capture into the session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureReady, handOff } from './bootstrap.mjs';

const args = process.argv.slice(2);
const background = args.includes('--background');
const detached = args.includes('--detached');

export function syncLogPath() {
  return process.env.STARMEMORY_LOG_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'sync.log');
}

if (background && !detached) {
  const log = syncLogPath();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, `[${new Date().toISOString()}] hook pid ${process.pid}: starting detached sync\n`);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...args.filter((a) => a !== '--background'), '--detached'],
    { detached: true, stdio: ['ignore', fd, fd] }
  );
  child.unref();
  process.exit(0);
}

// From here on we are either an interactive invocation or the detached child.
const quiet = detached;
if (!(await ensureReady({ quiet }))) {
  process.exit(quiet ? 0 : 1);
}

// The detached child's stdout is the log file, so it runs the plain command:
// the summary line ("Scanned N files, ...") is exactly what belongs in the log.
// It also has no stdin to watch -- see handOff.
handOff('dist/cli.js', args.filter((a) => a !== '--detached'), { watchStdin: !detached });
