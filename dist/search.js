// Search orchestration -- design doc §07 "功能映射". Mirrors episodic-memory's
// search.ts feature set (vector / text / both, multi-concept AND, metadata
// filters), backed by store.ts + vector-index.ts instead of sqlite-vec.
import { generateQueryEmbedding } from './embeddings.js';
import { filterIds, getExchange, textSearch } from './store.js';
/** Reciprocal Rank Fusion constant. 60 is the value from the original paper; its
 * job is to flatten the top of each list so one path's first place cannot
 * automatically outrank a document both paths agree on (design doc §06). */
export const RRF_K = 60;
/** Merge several ranked id lists by rank alone. BM25 scores are unbounded and
 * corpus-dependent while cosine similarity is bounded, so the two are not
 * comparable and min-max normalising a few dozen results is unstable. Ranks are
 * the one thing both paths agree on (design doc §06). */
export function fuseByReciprocalRank(rankedIdLists, k = RRF_K) {
    const entries = new Map();
    rankedIdLists.forEach((ids, listIndex) => {
        ids.forEach((id, position) => {
            const rank = position + 1;
            let entry = entries.get(id);
            if (!entry) {
                entry = { id, score: 0, ranks: new Array(rankedIdLists.length).fill(undefined) };
                entries.set(id, entry);
            }
            // A document listed twice by one path keeps its best rank and scores once.
            if (entry.ranks[listIndex] !== undefined)
                return;
            entry.ranks[listIndex] = rank;
            entry.score += 1 / (k + rank);
        });
    });
    return [...entries.values()].sort((a, b) => b.score - a.score);
}
/** The line a reader sees in a result list. Normally the question, because that
 * is what identifies a conversation. When the user side was an injected block
 * that normalised to nothing, fall back to the answer, which is the real content
 * of those records. */
function snippetOf(exchange) {
    const source = exchange.userMessage.trim() ? exchange.userMessage : exchange.assistantMessage;
    const s = source.slice(0, 200).replace(/\s+/g, ' ').trim();
    return s + (source.length > 200 ? '...' : '');
}
/** How deep each path digs before fusion. Too shallow and the two lists barely
 * overlap, which turns RRF back into "concatenate two lists" (design doc §06). */
export const CANDIDATE_DEPTH = 50;
/** Hybrid retrieval. Both paths run with the metadata filter already pushed down,
 * then their ranked id lists are fused (design doc §06/§07).
 *
 * `textIndex` is optional: without the compiled addon we fall back to the old
 * substring scan, which still answers exact-match queries. */
export async function search(store, index, query, options = {}, textIndex) {
    const { mode = 'hybrid', limit = 10, after, before, project, sessionId, harness } = options;
    const resolvedMode = mode === 'both' ? 'hybrid' : mode;
    const useVector = resolvedMode === 'vector' || resolvedMode === 'hybrid';
    const useText = resolvedMode === 'text' || resolvedMode === 'hybrid';
    const depth = resolvedMode === 'hybrid' ? Math.max(CANDIDATE_DEPTH, limit) : limit;
    const lists = [];
    const similarityById = new Map();
    let vectorList = -1;
    let textList = -1;
    if (useVector) {
        // The filter is applied inside the graph traversal via ArrayIdFilter, so
        // there is no over-fetch-and-trim. Subagent turns never reach here at all:
        // store.ts does not give them a vector (design doc §07).
        const ids = filterIds(store, { project, sessionId, harness, after, before });
        const queryEmbedding = await generateQueryEmbedding(query);
        const hits = index.search(queryEmbedding, depth, ids);
        for (const { id, score } of hits)
            similarityById.set(id, score);
        vectorList = lists.push(hits.map((h) => h.id)) - 1;
    }
    if (useText) {
        const ids = textIndex
            ? textIndex.search(query, depth, { project, sessionId, harness, after, before }).map((h) => h.id)
            : textSearch(store, query, { after, before, project, sessionId, harness, limit: depth }).map((e) => e.id);
        textList = lists.push(ids) - 1;
    }
    const results = [];
    for (const entry of fuseByReciprocalRank(lists)) {
        const exchange = getExchange(store, entry.id);
        if (!exchange)
            continue;
        results.push({
            exchange,
            snippet: snippetOf(exchange),
            similarity: similarityById.get(entry.id),
            score: entry.score,
            vectorRank: vectorList >= 0 ? entry.ranks[vectorList] : undefined,
            textRank: textList >= 0 ? entry.ranks[textList] : undefined,
        });
        if (results.length >= limit)
            break;
    }
    return results;
}
/** N-concept AND search (design doc §07): run each concept as its own vector
 * search, keep only exchanges present in every concept's hit set, rank by the
 * average of the per-concept scores. */
export async function searchMultipleConcepts(store, index, concepts, options = {}) {
    const { limit = 10, project, sessionId, harness } = options;
    const ids = filterIds(store, { project, sessionId, harness });
    const perConcept = await Promise.all(concepts.map(async (concept) => {
        const embedding = await generateQueryEmbedding(concept);
        return index.search(embedding, limit * 5, ids);
    }));
    const scoresById = new Map();
    perConcept.forEach((hits, conceptIndex) => {
        for (const { id, score } of hits) {
            const arr = scoresById.get(id) ?? new Array(concepts.length).fill(undefined);
            arr[conceptIndex] = score;
            scoresById.set(id, arr);
        }
    });
    const out = [];
    for (const [id, scores] of scoresById) {
        if (scores.some((s) => s === undefined))
            continue; // must appear for every concept
        const exchange = getExchange(store, id);
        if (!exchange)
            continue;
        const averageSimilarity = scores.reduce((a, b) => a + b, 0) / scores.length;
        out.push({ exchange, snippet: snippetOf(exchange), conceptSimilarities: scores, averageSimilarity });
    }
    out.sort((a, b) => b.averageSimilarity - a.averageSimilarity);
    return out.slice(0, limit);
}
