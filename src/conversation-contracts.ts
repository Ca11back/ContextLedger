// Client-safe DTOs for the conversation API (parent contract §5). Types and constants only.

export type Completeness = 'complete' | 'partial' | 'error';
export type LinkRule = 'prev_id' | 'prefix' | 'prefix_partial' | null;
export type ContextReset = 'window_changed' | 'no_prefix' | null;
export type MessageKind =
  | 'system'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'media'
  | 'refusal'
  | 'context'
  | 'other';

export interface SearchOperation {
  kind: 'search' | 'literature' | 'image' | 'open' | 'click' | 'find' | 'other';
  text: string;
}

export interface SearchSummary {
  recordId: number;
  operations: SearchOperation[];
  resultCount: number | null;
}

export type IncompleteReason = 'truncated' | 'no_terminal' | null;

export interface ConversationRef {
  id: number;
  title: string;
}

export interface ConversationRow {
  id: number;
  title: string;
  user: string;
  token: string;
  models: string[];
  moreModels: boolean;
  ownTurns: number;
  inheritedTurns: number;
  firstAt: number;
  lastAt: number;
  inputTokens: number | null;
  outputTokens: number | null;
  charge: number | null;
  chargePartial: boolean;
  /** Cache-read tokens, cache-write tokens, normalized total input, gateway charge in USD; null = unknown. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTotalTokens: number | null;
  chargeUsd: number | null;
  hasError: boolean;
  hasPartial: boolean;
  forkedFrom: { id: number; turn: number } | null;
  branchCount: number;
  subagentOf: ConversationRef | null;
  agentName: string | null;
  subagentKind: string | null;
  subagentCount: number;
  /** Linked web searches attached to this conversation; their charges are in the totals. */
  searchCount: number;
}

export interface ConversationList {
  rows: ConversationRow[];
  cursor: string | null;
}

export interface ConversationDetail {
  conversation: ConversationRow;
  /** Null when the source conversation was removed by retention but the link is known. */
  forkedFrom: { id: number; turn: number; title: string | null; removed: boolean } | null;
  branchesPreview: { atTurn: number; id: number; title: string }[];
  branchCount: number;
  subagentOf: { id: number; title: string | null; removed: boolean } | null;
  subagentsPreview: (ConversationRef & { agentName: string | null })[];
  subagentCount: number;
  /** Highest existing own turn index; null when the conversation has no retained turn. */
  lastTurnIndex: number | null;
}

export interface TurnSummary {
  turnIndex: number;
  recordId: number;
  requestId: string;
  receivedAt: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  charge: number | null;
  durationMs: number | null;
  completeness: Completeness;
  linkRule: LinkRule;
  parentOutputIncomplete: boolean;
  contextReset: ContextReset;
  /** Model stop reason as reported (e.g. MAX_TOKENS, SAFETY, length), when known. */
  stopReason?: string | null;
  /** Why a partial reply is partial, when the capture tells it apart; null otherwise. */
  incompleteReason: IncompleteReason;
  /** Cache-read tokens, cache-write tokens, normalized total input, gateway charge in USD; null = unknown. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTotalTokens: number | null;
  chargeUsd: number | null;
  /** Same-conversation turn this request retries (identical input), when it is a retry. */
  retryOf?: number | null;
  /** A later turn in this conversation retried this one with identical input. */
  superseded?: boolean;
  media: boolean;
}

export interface TurnList {
  turns: TurnSummary[];
  cursor: string | null;
}

export type Fragment =
  | { type: 'turn'; turn: TurnSummary }
  | { type: 'reset'; turnIndex: number; reason: 'window_changed' | 'no_prefix' }
  | {
      type: 'message';
      messageId: string;
      turnIndex: number;
      side: 'input' | 'output';
      kind: MessageKind;
      role?: string;
      name?: string;
      callId?: string;
      media?: { label: string };
      alternatives?: number;
      /** Carried history of a root or context-reset turn, folded by the UI. Default false. */
      leadingHistory?: boolean;
      /** Linked Codex web searches whose output appears in this tool result. */
      searches?: SearchSummary[];
      partCount: number;
    }
  | {
      type: 'chunk';
      messageId: string;
      partIndex: number;
      partKind: 'text' | 'json';
      offset: number;
      text: string;
      nextOffset: number | null;
      partTotal: number;
      continuation: string | null;
    };

export interface FragmentPage {
  fragments: Fragment[];
  cursor: string | null;
}

export interface TextChunk {
  messageId: string;
  partIndex: number;
  offset: number;
  text: string;
  nextOffset: number | null;
  partTotal: number;
  continuation: string | null;
}

export interface RequestRow {
  recordId: number;
  requestId: string;
  receivedAt: number;
  source: string;
  user: string;
  token: string;
  model: string;
  protocol: string;
  completeness: Completeness;
  truncated: boolean;
  media: boolean;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  charge: number | null;
  conversationId: number | null;
  turnIndex: number | null;
  /** Cache-read tokens, cache-write tokens, normalized total input, gateway charge in USD; null = unknown. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  inputTotalTokens: number | null;
  chargeUsd: number | null;
  incompleteReason: IncompleteReason;
  /** Web search projection; null for every request that is not a search. */
  search: {
    operations: SearchOperation[];
    resultCount: number | null;
    linked: { conversationId: number; turnIndex: number } | null;
  } | null;
}

export interface RequestList {
  rows: RequestRow[];
  cursor: string | null;
}

export interface LookupCandidate {
  recordId: number;
  conversationId: number | null;
  turnIndex: number | null;
  source: string;
  receivedAt: number;
}

export interface LookupResult {
  candidates: LookupCandidate[];
}

export const CONVERSATION_PAGE_LIMIT = 50;
export const REQUEST_PAGE_LIMIT = 50;
export const API_RESPONSE_MAX_BYTES = 64 * 1024;
export const TEXT_CHUNK_CHARS = 8192;
