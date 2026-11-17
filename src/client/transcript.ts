import type { Fragment, TextChunk, TurnSummary } from '../conversation-contracts';

type MessageFragment = Extract<Fragment, { type: 'message' }>;

export interface PartView {
  partIndex: number;
  partKind: 'text' | 'json';
  partTotal: number;
  /** Loaded text, contiguous from offset 0. */
  text: string;
  /** Continuation token for the next unloaded range, null when complete. */
  continuation: string | null;
}

export interface MessageView extends Omit<MessageFragment, 'type'> {
  parts: PartView[];
}

export interface TurnView {
  turn: TurnSummary;
  reset: 'window_changed' | 'no_prefix' | null;
  messages: MessageView[];
}

/**
 * Folds the fragment stream into turns. Chunks are keyed by (messageId, partIndex, offset):
 * a chunk is appended only when it starts exactly where the loaded text ends, so a range is
 * never shown twice and never with a gap.
 */
export function buildTranscript(fragments: readonly Fragment[]): TurnView[] {
  const turns: TurnView[] = [];
  const byTurn = new Map<number, TurnView>();
  const messages = new Map<string, MessageView>();
  const pendingReset = new Map<number, 'window_changed' | 'no_prefix'>();
  for (const fragment of fragments) {
    if (fragment.type === 'reset') {
      const existing = byTurn.get(fragment.turnIndex);
      if (existing) existing.reset = fragment.reason;
      else pendingReset.set(fragment.turnIndex, fragment.reason);
    } else if (fragment.type === 'turn') {
      if (byTurn.has(fragment.turn.turnIndex)) continue;
      const view: TurnView = {
        turn: fragment.turn,
        reset: pendingReset.get(fragment.turn.turnIndex) ?? fragment.turn.contextReset,
        messages: [],
      };
      byTurn.set(fragment.turn.turnIndex, view);
      turns.push(view);
    } else if (fragment.type === 'message') {
      if (messages.has(fragment.messageId)) continue;
      const { type: _type, ...header } = fragment;
      const view: MessageView = { ...header, parts: [] };
      messages.set(fragment.messageId, view);
      byTurn.get(fragment.turnIndex)?.messages.push(view);
    } else {
      const message = messages.get(fragment.messageId);
      if (message) appendChunk(message, fragment);
    }
  }
  turns.sort((a, b) => a.turn.turnIndex - b.turn.turnIndex);
  return turns;
}

export function appendChunk(
  message: MessageView,
  chunk: Pick<
    TextChunk,
    'partIndex' | 'offset' | 'text' | 'nextOffset' | 'partTotal' | 'continuation'
  > & {
    partKind?: 'text' | 'json';
  },
): boolean {
  let part = message.parts.find((candidate) => candidate.partIndex === chunk.partIndex);
  if (!part) {
    if (chunk.offset !== 0) return false;
    part = {
      partIndex: chunk.partIndex,
      partKind: chunk.partKind ?? 'text',
      partTotal: chunk.partTotal,
      text: '',
      continuation: null,
    };
    message.parts.push(part);
    message.parts.sort((a, b) => a.partIndex - b.partIndex);
  }
  if (chunk.offset !== part.text.length) return false;
  part.text += chunk.text;
  part.continuation = chunk.nextOffset === null ? null : chunk.continuation;
  return true;
}

/** Merges expanded continuation chunks (keyed by messageId) into a transcript copy. */
export function withExpansions(
  turns: TurnView[],
  expansions: ReadonlyMap<string, readonly TextChunk[]>,
): TurnView[] {
  if (!expansions.size) return turns;
  return turns.map((turn) => ({
    ...turn,
    messages: turn.messages.map((message) => {
      const chunks = expansions.get(message.messageId);
      if (!chunks) return message;
      const copy: MessageView = {
        ...message,
        parts: message.parts.map((part) => ({ ...part })),
      };
      for (const chunk of chunks) appendChunk(copy, chunk);
      return copy;
    }),
  }));
}
