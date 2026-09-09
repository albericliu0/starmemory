/** Which coding agent wrote the transcript an exchange came from. Both share one
 * store (design doc §16); the tag is what lets a search ask for only one side. */
export type Harness = 'claude' | 'codex';

/** A single user/assistant exchange, mirroring episodic-memory's ConversationExchange
 * (see design doc §05/§07) but trimmed to what this engine actually persists. */
export interface ConversationExchange {
  id: number;
  /** Absent on rows stored before Codex support; read those as `claude`. */
  harness?: Harness;
  project: string;
  sessionId?: string;
  gitBranch?: string;
  timestamp: string; // ISO 8601
  userMessage: string;
  assistantMessage: string;
  archivePath: string;
  lineStart: number;
  lineEnd: number;
  embeddingVersion: number;
  /** Subagent/sidechain turns are parsed and stored but excluded from search by
   * default, matching episodic-memory's `is_sidechain = 0` filter. */
  isSidechain?: boolean;
  /** True when the user side of this exchange was written by Claude Code rather
   * than typed by a person: a task notification, a slash-command echo, local
   * command output, a system reminder. `userMessage` then holds the normalised
   * payload, not the raw block. */
  userIsInjected?: boolean;
}

/** A parsed exchange before it has an id (store.ts assigns one on insert). */
export type ParsedExchange = Omit<ConversationExchange, 'id' | 'embeddingVersion'>;

export interface SearchOptions {
  /** `both` is kept as an alias for `hybrid` so the MCP tool schema does not change. */
  mode?: 'vector' | 'text' | 'hybrid' | 'both';
  limit?: number;
  after?: string;
  before?: string;
  project?: string;
  sessionId?: string;
  harness?: Harness;
}

export interface SearchResult {
  exchange: ConversationExchange;
  similarity?: number; // cosine similarity, undefined for pure text hits
  /** Fused rank score (design doc §06). Comparable within one result set only. */
  score?: number;
  /** 1-based rank each path gave this exchange, undefined where it did not appear.
   * Kept in the result because "did this come up because of BM25 or the vector
   * search" is the first question anyone asks when tuning retrieval. */
  vectorRank?: number;
  textRank?: number;
  snippet: string;
}

export interface MultiConceptResult {
  exchange: ConversationExchange;
  snippet: string;
  conceptSimilarities: number[];
  averageSimilarity: number;
}
