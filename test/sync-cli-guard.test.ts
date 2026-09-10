// Design doc archive-and-summaries §06: a summarizer child fires SessionStart,
// whose hook is `starmemory sync`. Inside that child, sync must do nothing.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('starmemory sync inside a summarizer child', () => {
  it('exits 0 at once without touching the store or the log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-guard-'));
    const r = spawnSync(process.execPath, ['cli/starmemory.mjs', 'sync'], {
      env: {
        ...process.env,
        STARMEMORY_SUMMARIZER_GUARD: '1',
        STARMEMORY_DB_PATH: path.join(dir, 'store.mdb'),
        STARMEMORY_LOG_PATH: path.join(dir, 'sync.log'),
        STARMEMORY_ARCHIVE_PATH: path.join(dir, 'archive'),
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
