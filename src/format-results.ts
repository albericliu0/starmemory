// How search hits are printed for the MCP client. Kept apart from the server
// so the layout can be tested without starting one.
import { defaultArchiveRoot, resolveArchivePath } from './archive.js';
import { summaryFor } from './summaries.js';
import type { ConversationExchange, MultiConceptResult, SearchResult } from './types.js';

/** Rows from before the archive point at the source transcript; once Claude
 * Code has cleaned that up, the archive copy is what a reader can open. */
export function pathOf(e: ConversationExchange, archiveRoot: string): string {
  return resolveArchivePath(archiveRoot, e.archivePath, e.harness ?? 'claude', e.project);
}

/** One line above the snippet when the conversation has a short, valid summary
 * (design doc archive-and-summaries §08). */
function summaryLine(e: ConversationExchange, archiveRoot: string): string {
  const summary = summaryFor(e, archiveRoot);
  return summary ? `   Summary: ${summary}\n` : '';
}

export function formatResults(results: SearchResult[], archiveRoot = defaultArchiveRoot()): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => {
      const date = r.exchange.timestamp.slice(0, 10);
      const pct = r.similarity !== undefined ? ` - ${Math.round(r.similarity * 100)}% match` : '';
      const from = r.exchange.harness === 'codex' ? ', codex' : '';
      return `${i + 1}. [${r.exchange.project}, ${date}${from}]${pct}\n${summaryLine(r.exchange, archiveRoot)}   "${r.snippet}"\n   Lines ${r.exchange.lineStart}-${r.exchange.lineEnd} in ${pathOf(r.exchange, archiveRoot)}\n`;
    })
    .join('\n');
}

export function formatMultiConceptResults(
  results: MultiConceptResult[],
  concepts: string[],
  archiveRoot = defaultArchiveRoot()
): string {
  if (results.length === 0) return `No conversations found matching all concepts: ${concepts.join(', ')}`;
  return results
    .map((r, i) => {
      const date = r.exchange.timestamp.slice(0, 10);
      const scores = r.conceptSimilarities.map((s, j) => `${concepts[j]}: ${Math.round(s * 100)}%`).join(', ');
      return `${i + 1}. [${r.exchange.project}, ${date}] - ${Math.round(r.averageSimilarity * 100)}% avg match\n   Concepts: ${scores}\n${summaryLine(r.exchange, archiveRoot)}   "${r.snippet}"\n   Lines ${r.exchange.lineStart}-${r.exchange.lineEnd} in ${pathOf(r.exchange, archiveRoot)}\n`;
    })
    .join('\n');
}
