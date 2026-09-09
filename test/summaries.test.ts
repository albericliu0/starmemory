import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSummaryState, writeSummary, writeErrorSentinel, selectForSummary, transcriptText, summaryFor, extractSummary,
  type SummaryCandidate,
} from '../src/summaries.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-summaries-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-09-09T12:00:00Z');
function candidate(name: string, ageMs: number, extra: Partial<SummaryCandidate> = {}): SummaryCandidate {
  return { archivePath: path.join(dir, 'claude', 'p', `${name}.jsonl`), harness: 'claude', project: 'p', sessionId: name, sourceMtimeMs: now - ageMs, ...extra };
}
const summaryOf = (c: SummaryCandidate) => c.archivePath.replace(/\.jsonl$/, '-summary.txt');

describe('the summary file beside a conversation', () => {
  it('is missing, empty, an error, or valid', () => {
    const p = path.join(dir, 's-summary.txt');
    expect(readSummaryState(p)).toEqual({ kind: 'missing' });
    writeSummary(p, '   ');
    expect(readSummaryState(p)).toEqual({ kind: 'empty' });
    writeErrorSentinel(p, new Error('codex not found'));
    expect(readSummaryState(p)).toEqual({ kind: 'error', message: 'codex not found' });
    writeSummary(p, '  The user fixed a race.  ');
    expect(readSummaryState(p)).toEqual({ kind: 'valid', text: 'The user fixed a race.' });
  });
});

describe('selectForSummary', () => {
  it('skips conversations that were written to in the last two hours', () => {
    const picked = selectForSummary([candidate('busy', HOUR), candidate('quiet', 3 * HOUR)], { now });
    expect(picked.map((c) => c.sessionId)).toEqual(['quiet']);
  });
  it('takes the newest first and stops at the limit', () => {
    const cs = [candidate('a', 30 * HOUR), candidate('b', 3 * HOUR), candidate('c', 10 * HOUR)];
    expect(selectForSummary(cs, { now, limit: 2 }).map((c) => c.sessionId)).toEqual(['b', 'c']);
  });
  it('leaves out conversations with a valid or empty summary, keeps ones whose last try failed', () => {
    const done = candidate('done', 3 * HOUR);
    writeSummary(summaryOf(done), 'done');
    const nothing = candidate('nothing', 3 * HOUR);
    writeSummary(summaryOf(nothing), '');
    const failed = candidate('failed', 3 * HOUR);
    writeErrorSentinel(summaryOf(failed), 'boom');
    expect(selectForSummary([done, nothing, failed], { now }).map((c) => c.sessionId)).toEqual(['failed']);
  });
  it('picks nothing when the limit is zero', () => {
    expect(selectForSummary([candidate('q', 3 * HOUR)], { now, limit: 0 })).toEqual([]);
  });
});

describe('transcriptText', () => {
  const ex = (i: number) => ({ project: 'p', timestamp: 't', userMessage: `q${i}`, assistantMessage: `a${i}`, archivePath: '', lineStart: i, lineEnd: i });
  it('lays out each exchange as a User/Assistant pair', () => {
    expect(transcriptText([ex(1), ex(2)])).toBe('User: q1\nAssistant: a1\n\nUser: q2\nAssistant: a2');
  });
  it('keeps the head and the tail when the text is too long', () => {
    const text = transcriptText([ex(1), ex(2), ex(3), ex(4)], 40);
    expect(text.length).toBeLessThanOrEqual(40 + '\n[…]\n'.length);
    expect(text.startsWith('User: q1')).toBe(true);
    expect(text.endsWith('Assistant: a4')).toBe(true);
    expect(text).toContain('[…]');
  });
});

describe('summaryFor', () => {
  const exchange = { id: 1, harness: 'claude' as const, project: 'p', timestamp: 't', userMessage: '', assistantMessage: '', archivePath: '', lineStart: 1, lineEnd: 2, embeddingVersion: 1 };
  it('returns a short valid summary and nothing for missing, error, or long ones', () => {
    const root = path.join(dir, 'root');
    const copy = path.join(root, 'claude', 'p', 's1.jsonl');
    const e = { ...exchange, archivePath: copy };
    expect(summaryFor(e, root)).toBeUndefined();
    writeSummary(copy.replace(/\.jsonl$/, '-summary.txt'), 'Short and sweet.');
    expect(summaryFor(e, root)).toBe('Short and sweet.');
    writeErrorSentinel(copy.replace(/\.jsonl$/, '-summary.txt'), 'x');
    expect(summaryFor(e, root)).toBeUndefined();
    writeSummary(copy.replace(/\.jsonl$/, '-summary.txt'), 'x'.repeat(300));
    expect(summaryFor(e, root)).toBeUndefined();
  });
  it('finds the summary through the archive when the row still points at the source', () => {
    const root = path.join(dir, 'root');
    const copy = path.join(root, 'claude', 'p', 's1.jsonl');
    writeSummary(copy.replace(/\.jsonl$/, '-summary.txt'), 'Found it.');
    expect(summaryFor({ ...exchange, archivePath: path.join(dir, 'gone', 'p', 's1.jsonl') }, root)).toBe('Found it.');
  });
});

describe('extractSummary', () => {
  it('takes the text inside the tags and nothing else', () => {
    expect(extractSummary('Sure!\n<summary> The user fixed a race. </summary>\nAnything else?')).toBe('The user fixed a race.');
  });
  it('returns undefined for chatter without tags or empty tags', () => {
    expect(extractSummary("I'm ready to help. What next?")).toBeUndefined();
    expect(extractSummary('<summary>  </summary>')).toBeUndefined();
  });
});
