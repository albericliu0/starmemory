import type { ConversationExchange, MultiConceptResult, SearchResult } from './types.js';
/** Rows from before the archive point at the source transcript; once Claude
 * Code has cleaned that up, the archive copy is what a reader can open. */
export declare function pathOf(e: ConversationExchange, archiveRoot: string): string;
export declare function formatResults(results: SearchResult[], archiveRoot?: string): string;
export declare function formatMultiConceptResults(results: MultiConceptResult[], concepts: string[], archiveRoot?: string): string;
