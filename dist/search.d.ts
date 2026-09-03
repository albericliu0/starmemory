import { type StoreHandle } from './store.js';
import { VectorIndex } from './vector-index.js';
import type { TextIndex } from './text-index.js';
import type { MultiConceptResult, SearchOptions, SearchResult } from './types.js';
/** Reciprocal Rank Fusion constant. 60 is the value from the original paper; its
 * job is to flatten the top of each list so one path's first place cannot
 * automatically outrank a document both paths agree on (design doc §06). */
export declare const RRF_K = 60;
export interface FusedEntry {
    id: number;
    score: number;
    /** 1-based rank in each input list, undefined where the document is absent. */
    ranks: (number | undefined)[];
}
/** Merge several ranked id lists by rank alone. BM25 scores are unbounded and
 * corpus-dependent while cosine similarity is bounded, so the two are not
 * comparable and min-max normalising a few dozen results is unstable. Ranks are
 * the one thing both paths agree on (design doc §06). */
export declare function fuseByReciprocalRank(rankedIdLists: number[][], k?: number): FusedEntry[];
/** How deep each path digs before fusion. Too shallow and the two lists barely
 * overlap, which turns RRF back into "concatenate two lists" (design doc §06). */
export declare const CANDIDATE_DEPTH = 50;
/** Hybrid retrieval. Both paths run with the metadata filter already pushed down,
 * then their ranked id lists are fused (design doc §06/§07).
 *
 * `textIndex` is optional: without the compiled addon we fall back to the old
 * substring scan, which still answers exact-match queries. */
export declare function search(store: StoreHandle, index: VectorIndex, query: string, options?: SearchOptions, textIndex?: TextIndex): Promise<SearchResult[]>;
/** N-concept AND search (design doc §07): run each concept as its own vector
 * search, keep only exchanges present in every concept's hit set, rank by the
 * average of the per-concept scores. */
export declare function searchMultipleConcepts(store: StoreHandle, index: VectorIndex, concepts: string[], options?: Omit<SearchOptions, 'mode'>): Promise<MultiConceptResult[]>;
