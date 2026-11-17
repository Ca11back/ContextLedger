import { expect, test } from 'bun:test';
import { createDashboardQueryClient } from '../src/client/queries';
import {
  conversationFilterKeys,
  listParams,
  requestFilterKeys,
  validateAppSearch,
} from '../src/client/search';
import { appendChunk, buildTranscript, type MessageView } from '../src/client/transcript';
import type { Fragment, TurnSummary } from '../src/conversation-contracts';

test('URL state keeps conversation, turn and filters and rejects unsafe values', () => {
  expect(
    validateAppSearch({
      tab: 'requests',
      c: '12',
      t: '7',
      r: 'x',
      user: 'alice / 中文',
      status: 'error',
      kind: 'subagent',
      from: '100',
      to: '200',
      extra: 'ignored',
    }),
  ).toEqual({
    tab: 'requests',
    c: 12,
    t: 7,
    user: 'alice / 中文',
    status: 'error',
    kind: 'subagent',
    from: 100,
    to: 200,
  });
  expect(validateAppSearch({ t: '3' })).toEqual({});
  expect(validateAppSearch({ c: '0', status: 'weird', kind: 'x' })).toEqual({});
  expect(validateAppSearch({ from: '20', to: '10' })).toEqual({});
  expect(validateAppSearch({ user: 'a'.repeat(257) })).toEqual({});
});

test('list parameters carry only the filters each list supports', () => {
  const search = validateAppSearch({ c: '1', user: 'u', kind: 'main', status: 'partial' });
  const conversations = listParams(search, 'cur', conversationFilterKeys);
  expect(conversations.get('kind')).toBe('main');
  expect(conversations.get('cursor')).toBe('cur');
  expect(conversations.has('c')).toBe(false);
  const requests = listParams(search, null, requestFilterKeys);
  expect(requests.has('kind')).toBe(false);
  expect(requests.get('status')).toBe('partial');
});

const turn = (turnIndex: number, extra: Partial<TurnSummary> = {}): TurnSummary => ({
  turnIndex,
  recordId: turnIndex,
  requestId: `req-${turnIndex}`,
  receivedAt: turnIndex * 1000,
  model: 'synthetic-model',
  inputTokens: 1,
  outputTokens: 1,
  charge: null,
  durationMs: null,
  completeness: 'complete',
  linkRule: null,
  parentOutputIncomplete: false,
  contextReset: null,
  media: false,
  ...extra,
});

test('transcript folds fragments by turn, applies resets and never repeats or skips text', () => {
  const fragments: Fragment[] = [
    { type: 'turn', turn: turn(1) },
    {
      type: 'message',
      messageId: 'm1',
      turnIndex: 1,
      side: 'input',
      kind: 'user',
      partCount: 1,
    },
    {
      type: 'chunk',
      messageId: 'm1',
      partIndex: 0,
      partKind: 'text',
      offset: 0,
      text: 'hello ',
      nextOffset: 6,
      partTotal: 11,
      continuation: 'c1',
    },
    // A repeated page must not duplicate text.
    {
      type: 'chunk',
      messageId: 'm1',
      partIndex: 0,
      partKind: 'text',
      offset: 0,
      text: 'hello ',
      nextOffset: 6,
      partTotal: 11,
      continuation: 'c1',
    },
    { type: 'reset', turnIndex: 2, reason: 'window_changed' },
    { type: 'turn', turn: turn(2) },
    {
      type: 'message',
      messageId: 'm2',
      turnIndex: 2,
      side: 'input',
      kind: 'media',
      media: { label: 'image/png · 118 KB' },
      partCount: 0,
    },
  ];
  const turns = buildTranscript(fragments);
  expect(turns.map((view) => view.turn.turnIndex)).toEqual([1, 2]);
  expect(turns[1]?.reset).toBe('window_changed');
  const message = turns[0]?.messages[0] as MessageView;
  expect(message.parts[0]?.text).toBe('hello ');
  expect(message.parts[0]?.continuation).toBe('c1');
  // A gap is rejected; the exact continuation is accepted and ends the part.
  expect(
    appendChunk(message, {
      partIndex: 0,
      offset: 7,
      text: 'x',
      nextOffset: null,
      partTotal: 11,
      continuation: null,
    }),
  ).toBe(false);
  expect(
    appendChunk(message, {
      partIndex: 0,
      offset: 6,
      text: 'world',
      nextOffset: null,
      partTotal: 11,
      continuation: null,
    }),
  ).toBe(true);
  expect(message.parts[0]?.text).toBe('hello world');
  expect(message.parts[0]?.continuation).toBeNull();
});

test('request-scoped query clients do not share private data', () => {
  const first = createDashboardQueryClient();
  const second = createDashboardQueryClient();
  first.setQueryData(['metrics'], { records: 1 });
  expect(second.getQueryData(['metrics'])).toBeUndefined();
  first.clear();
  second.clear();
});
