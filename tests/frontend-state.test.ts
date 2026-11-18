import { expect, test } from 'bun:test';
import {
  conversationsQuery,
  createDashboardQueryClient,
  fragmentsQuery,
  requestsQuery,
} from '../src/client/queries';
import {
  EARLIER_STEP,
  earlierRanges,
  earlierStart,
  initialStart,
  mainStart,
  movedUpByReader,
  TAIL_TURNS,
  upwardScrollKey,
} from '../src/client/reading';
import {
  appSearchSchema,
  conversationFilterKeys,
  hasFilters,
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

test('URL search schema applies each field fallback on its own', () => {
  // Numbers arrive as numbers from the router's JSON-aware search parser, or as strings.
  expect(validateAppSearch({ c: 5, t: 2, r: 9 })).toEqual({ c: 5, t: 2, r: 9 });
  expect(validateAppSearch({ c: 123456789012345 })).toEqual({ c: 123456789012345 });
  for (const bad of ['1234567890123456', '-1', '1.5', 1.5, -3, '0x10', ' 7', '', null, true, {}])
    expect(validateAppSearch({ c: bad })).toEqual({});
  // One bad field never discards the others.
  expect(validateAppSearch({ c: 'x', r: '4', user: 7, token: 't', tab: 'other' })).toEqual({
    r: 4,
    token: 't',
  });
  expect(validateAppSearch({ user: '', model: 'a'.repeat(256) })).toEqual({
    model: 'a'.repeat(256),
  });
  // Equal bounds and a single bound are kept; only an inverted range is dropped.
  expect(validateAppSearch({ from: '10', to: '10' })).toEqual({ from: 10, to: 10 });
  expect(validateAppSearch({ from: '20' })).toEqual({ from: 20 });
  expect(validateAppSearch({ c: 'bad', t: '3' })).toEqual({});
  // Unknown keys are dropped and undefined values never reach the URL.
  const parsed = validateAppSearch({ c: '1', t: undefined, cursor: 'x' });
  expect(Object.keys(parsed)).toEqual(['c']);
  // The schema itself is what the route validates with, so it never throws.
  expect(appSearchSchema.safeParse({ status: 1, kind: [] }).success).toBe(true);
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
  cacheReadTokens: null,
  cacheWriteTokens: null,
  inputTotalTokens: null,
  chargeUsd: null,
  recordId: turnIndex,
  requestId: `req-${turnIndex}`,
  receivedAt: turnIndex * 1000,
  model: 'synthetic-model',
  inputTokens: 1,
  outputTokens: 1,
  charge: null,
  durationMs: null,
  completeness: 'complete',
  incompleteReason: null,
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

test('conversation sort is a URL param for the conversation list only', () => {
  expect(validateAppSearch({ sort: 'cost' })).toEqual({ sort: 'cost' });
  // Absent means most recent; any other value falls back to absent.
  expect(validateAppSearch({ sort: 'recent' })).toEqual({});
  expect(validateAppSearch({ sort: 1 })).toEqual({});
  const search = validateAppSearch({ sort: 'cost', user: 'u' });
  expect(listParams(search, null, conversationFilterKeys).get('sort')).toBe('cost');
  expect(listParams(search, null, requestFilterKeys).has('sort')).toBe(false);
  // Sorting is not a filter: it never turns on "clear filters" or the filtered empty state.
  expect(hasFilters(validateAppSearch({ sort: 'cost' }))).toBe(false);
});

test('list requests carry sort=cost only to the conversation endpoint', async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ rows: [], cursor: null }), { status: 200 });
  }) as typeof fetch;
  const client = createDashboardQueryClient();
  try {
    const sorted = validateAppSearch({ sort: 'cost', user: 'u' });
    await client.fetchInfiniteQuery(conversationsQuery(sorted));
    await client.fetchInfiniteQuery(requestsQuery(sorted));
    await client.fetchInfiniteQuery(conversationsQuery(validateAppSearch({ user: 'u' })));
  } finally {
    globalThis.fetch = original;
    client.clear();
  }
  expect(urls).toEqual([
    '/api/conversations?user=u&sort=cost',
    '/api/requests?user=u',
    '/api/conversations?user=u',
  ]);
  // Distinct sort orders never share a cache entry.
  expect(conversationsQuery(validateAppSearch({ sort: 'cost' })).queryKey).not.toEqual(
    conversationsQuery(validateAppSearch({})).queryKey,
  );
});

test('the reader opens at the latest turns unless anchored and loads earlier ranges in steps', () => {
  expect(TAIL_TURNS).toBe(5);
  expect(EARLIER_STEP).toBe(10);
  expect(initialStart(undefined)).toEqual({ kind: 'tail' });
  expect(initialStart(7)).toEqual({ kind: 'anchor', turn: 7 });
  // Latest five turns of a 40-turn conversation; short or empty ones start at turn 1.
  expect(mainStart({ kind: 'tail' }, 40)).toBe(36);
  expect(mainStart({ kind: 'tail' }, 3)).toBe(1);
  expect(mainStart({ kind: 'tail' }, null)).toBe(1);
  expect(mainStart({ kind: 'anchor', turn: 12 }, 40)).toBe(12);
  expect(mainStart({ kind: 'top' }, 40)).toBe(1);
  expect(earlierStart(36)).toBe(26);
  expect(earlierStart(8)).toBe(1);
  // Ranges are contiguous, oldest first, and end where the next later range begins.
  expect(earlierRanges(36, [26, 16, 6, 1])).toEqual([
    { from: 1, until: 6 },
    { from: 6, until: 16 },
    { from: 16, until: 26 },
    { from: 26, until: 36 },
  ]);
  expect(earlierRanges(36, [])).toEqual([]);
});

test('fragment streams start exactly at anchors and from the next existing turn otherwise', async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ fragments: [], cursor: null }), { status: 200 });
  }) as typeof fetch;
  const client = createDashboardQueryClient();
  try {
    await client.fetchInfiniteQuery(fragmentsQuery(4, 12));
    await client.fetchInfiniteQuery(fragmentsQuery(4, 36, 'from'));
    await client.fetchInfiniteQuery(fragmentsQuery(4, 1, 'from'));
  } finally {
    globalThis.fetch = original;
    client.clear();
  }
  expect(urls).toEqual([
    '/api/conversations/4/fragments?startTurn=12',
    '/api/conversations/4/fragments?fromTurn=36',
    '/api/conversations/4/fragments?',
  ]);
  // From turn 1 is the whole conversation and shares the unanchored cache entry.
  expect(fragmentsQuery(4, 1, 'from').queryKey).toEqual(fragmentsQuery(4, undefined).queryKey);
  expect(fragmentsQuery(4, 12, 'from').queryKey).not.toEqual(fragmentsQuery(4, 12).queryKey);
});

test('only reader intent releases the pin to the end, not layout', () => {
  const before = { top: 1000, height: 2000 };
  // Content grew below while pinned (late layout): no upward move, stays pinned.
  expect(movedUpByReader(before, { scrollTop: 1000, scrollHeight: 3500 })).toBe(false);
  // Placeholder above shrank: offset and height fall together (anchoring or clamping).
  expect(movedUpByReader(before, { scrollTop: 826, scrollHeight: 1826 })).toBe(false);
  // Home, scrollbar drag or a programmatic jump to the top.
  expect(movedUpByReader(before, { scrollTop: 0, scrollHeight: 2000 })).toBe(true);
  expect(movedUpByReader(before, { scrollTop: 980, scrollHeight: 2000 })).toBe(false);
  for (const key of ['PageUp', 'ArrowUp', 'Home', '['])
    expect(upwardScrollKey({ key, shiftKey: false })).toBe(true);
  expect(upwardScrollKey({ key: ' ', shiftKey: true })).toBe(true);
  expect(upwardScrollKey({ key: ' ', shiftKey: false })).toBe(false);
  expect(upwardScrollKey({ key: 'End', shiftKey: false })).toBe(false);
});
