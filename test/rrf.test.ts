// Reciprocal Rank Fusion -- design doc §06. Pure ranking maths, no index needed.
import { describe, it, expect } from 'vitest';
import { fuseByReciprocalRank, RRF_K } from '../src/search.js';

describe('reciprocalRankFusion', () => {
  it('scores a document by 1/(k + rank), counting ranks from one', () => {
    const [entry] = fuseByReciprocalRank([[42]]);

    expect(entry.id).toBe(42);
    expect(entry.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('adds one term per list the document appears in', () => {
    const [entry] = fuseByReciprocalRank([[7], [7]]);

    expect(entry.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('ranks a document found by both paths above one found by a single path', () => {
    // 5 is second-best in each list; 1 and 2 each top one list and miss the other.
    const fused = fuseByReciprocalRank([
      [1, 5],
      [2, 5],
    ]);

    expect(fused[0].id).toBe(5);
  });

  it('returns entries sorted by descending score', () => {
    const fused = fuseByReciprocalRank([[1, 2, 3]]);

    expect(fused.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it('keeps a document that only one path found', () => {
    const fused = fuseByReciprocalRank([[1], [2]]);

    expect(fused.map((e) => e.id).sort()).toEqual([1, 2]);
  });

  it('records each document rank per list, and undefined where it is absent', () => {
    const fused = fuseByReciprocalRank([
      [9, 8],
      [8],
    ]);

    const nine = fused.find((e) => e.id === 9)!;
    const eight = fused.find((e) => e.id === 8)!;
    expect(nine.ranks).toEqual([1, undefined]);
    expect(eight.ranks).toEqual([2, 1]);
  });

  it('ignores an empty list without shifting the other list ranks', () => {
    const withEmpty = fuseByReciprocalRank([[1, 2], []]);
    const alone = fuseByReciprocalRank([[1, 2]]);

    expect(withEmpty.map((e) => e.score)).toEqual(alone.map((e) => e.score));
  });

  it('returns nothing when every list is empty', () => {
    expect(fuseByReciprocalRank([[], []])).toEqual([]);
  });

  it('accepts a different k', () => {
    const [entry] = fuseByReciprocalRank([[42]], 9);

    expect(entry.score).toBeCloseTo(1 / 10, 10);
  });
});
