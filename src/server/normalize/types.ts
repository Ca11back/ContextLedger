import type { IncompleteReason } from '../../conversation-contracts';
import type { DeclaredIdentity, IsolationDomain } from '../identity';

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
export type Completeness = 'complete' | 'partial' | 'error';
export interface NormalizedPart {
  kind: 'text' | 'json';
  text: string;
}
export interface AnnouncedOutputItem {
  index: number;
  type: string;
  idHash: string;
  completedHash?: string;
}
/** Ephemeral derived view. Never persisted as a second copy of the evidence. */
export interface NormalizedMessage {
  side: 'input' | 'output';
  /** Stable zero-based position in this side's normalized message sequence. */
  index: number;
  kind: MessageKind;
  role?: string;
  name?: string;
  callId?: string;
  media?: { label: string };
  alternatives?: number;
  parts: NormalizedPart[];
  /** Actual source user text only, bounded to 120 UTF-16 units; never display placeholders. */
  userText: string;
  /** Responses-only source shell metadata; never extracted from user payloads. */
  wireItemType?: string;
  itemIdHash?: string;
  /** Actual captured Responses output_index, retained to detect missing items. */
  outputIndex?: number;
  /** False when a known shell contains unknown content that cannot prove a prefix. */
  prefixKnown?: boolean;
  /** Full, uncapped per-format identity projection hash; never hashes display labels. */
  itemHash: string;
  completed: boolean;
  /** Known, non-empty assistant/tool-call content eligible for partial coverage. */
  evidence: boolean;
}
export interface NormalizedRequest {
  protocol: string;
  chat: boolean;
  domain: IsolationDomain | null;
  userId: string | null;
  tokenId: string | null;
  identity: DeclaredIdentity | null;
  completeness: Completeness;
  incompleteReason: IncompleteReason;
  announcedOutput: AnnouncedOutputItem[];
  announcementsValid: boolean;
  input: NormalizedMessage[];
  output: NormalizedMessage[];
  /** Complete output, or completed meaningful assistant/tool calls for a partial capture. */
  evidence: NormalizedMessage[];
  inputCount: number;
  /** Count of input ++ evidence, for coverage against a child's input. */
  evidenceCount: number;
  inputChain: string | null;
  /** Full-input fingerprint even for previous_response_id mode and empty inputs. */
  retryInputChain: string;
  evidenceChain: string | null;
  /** Entry i covers input[0..i], in sequence order. Storage queries newest <=4096. */
  inputPrefixes: string[];
  inputEligible: boolean;
  responseId: string | null;
  previousResponseId: string | null;
  title: string;
  /** Last non-empty actual source user text in the full input, including leading history. */
  lastUserText: string;
  leadingHistoryCount: number;
  media: boolean;
  stopReason: string | null;
}
