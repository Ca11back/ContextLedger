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
  input: NormalizedMessage[];
  output: NormalizedMessage[];
  /** Complete output, or completed meaningful assistant/tool calls for a partial capture. */
  evidence: NormalizedMessage[];
  inputCount: number;
  /** Count of input ++ evidence, for coverage against a child's input. */
  evidenceCount: number;
  inputChain: string | null;
  evidenceChain: string | null;
  /** Entry i covers input[0..i], in sequence order. Storage queries newest <=4096. */
  inputPrefixes: string[];
  inputEligible: boolean;
  responseId: string | null;
  previousResponseId: string | null;
  title: string;
  leadingHistoryCount: number;
  media: boolean;
  stopReason: string | null;
}
