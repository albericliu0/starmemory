import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatResults, formatMultiConceptResults } from '../src/format-results.js';
import { writeSummary } from '../src/summaries.js';
import type { ConversationExchange } from '../src/types.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-format-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function exchange(id: number, name: string): ConversationExchange {
  const copy = path.join(dir, 'archive', 'claude', 'proj', `${name}.jsonl.gz`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, '');
  return { id, harness: 'claude', project: 'proj', timestamp: '2026-09-09T10:00:00.000Z', userMessage: `q${id}`, assistantMessage: `a${id}`, archivePath: copy, lineStart: 1, lineEnd: 2, embeddingVersion: 1 };
}

describe('search results', () => {
  it('show a Summary line only for hits whose conversation has one', () => {
    const root = path.join(dir, 'archive');
    const withSummary = exchange(1, 'with');
    const without = exchange(2, 'without');
    writeSummary(path.join(root, 'claude', 'proj', 'with-summary.txt'), 'The user fixed a race.');

    const text = formatResults([
      { exchange: withSummary, snippet: 'q1', similarity: 0.5 },
      { exchange: without, snippet: 'q2', similarity: 0.4 },
    ], root);

    const [first, second] = text.split('\n\n');
    expect(first).toContain('   Summary: The user fixed a race.\n   "q1"');
    expect(second).not.toContain('Summary:');
    expect(second).toContain(`Lines 1-2 in ${without.archivePath}`);
  });

  it('point at the archive copy once the source transcript is gone', () => {
    const root = path.join(dir, 'archive');
    const e = exchange(1, 's1');
    const copy = e.archivePath;
    const stale = { ...e, archivePath: path.join(dir, 'cleaned-up', 'proj', 's1.jsonl') };

    expect(formatResults([{ exchange: stale, snippet: 'q' }], root)).toContain(`in ${copy}`);
  });

  it('carry the summary in multi-concept output too', () => {
    const root = path.join(dir, 'archive');
    const e = exchange(1, 'multi');
    writeSummary(path.join(root, 'claude', 'proj', 'multi-summary.txt'), 'Two concepts met.');

    const text = formatMultiConceptResults([{ exchange: e, snippet: 'q', conceptSimilarities: [0.5, 0.6], averageSimilarity: 0.55 }], ['a', 'b'], root);

    expect(text).toContain('Concepts: a: 50%, b: 60%\n   Summary: Two concepts met.\n   "q"');
  });
});
