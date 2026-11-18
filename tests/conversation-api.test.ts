import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../src/contracts';
import type { ConversationList, Fragment, FragmentPage } from '../src/conversation-contracts';
import { hash } from '../src/server/codec';
import type { Config } from '../src/server/config';
import {
  boundedJson,
  boundedUploads,
  conversationDetail,
  conversationHttp,
  conversations,
  fragments,
  lookup,
  relations,
  requestDetail,
  requests,
  textContinuation,
  turns,
} from '../src/server/conversation-api';
import { LedgerError } from '../src/server/errors';
import { canonicalJson } from '../src/server/normalize';
import { Ledger } from '../src/server/storage';
import { estimatePartial } from './support/partial-estimate';
import { partialLoopFixtures } from './support/partial-fixtures';
import { estimateRetry } from './support/retry-estimate';

const fixtures: { store: Ledger; directory: string }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-conversations-'));
  const config: Config = {
    database: join(directory, 'ledger.sqlite'),
    maxStorageBytes: 128 * 1024 * 1024,
    reserveBytes: 256 * 1024,
    maxBodyBytes: 32 * 1024 * 1024,
    adminUser: 'admin',
    adminPassword: 'synthetic-admin-password',
    ingestToken: 'synthetic-ingest-token-12345678',
    source: 'synthetic',
    maintenanceMs: 30000,
  };
  const store = new Ledger(config);
  fixtures.push({ store, directory });
  return store;
}
function envelope(
  input: unknown = [{ role: 'user', content: 'hello' }],
  output: unknown = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
  ],
  body: Record<string, unknown> = {},
  format = 'openai_responses',
): Envelope {
  return {
    version: 1,
    upload_id: crypto.randomUUID(),
    source: 'synthetic',
    context: { format, model: 'model' },
    report: {
      requestId: 'gateway-id',
      user: { id: 1, username: 'user' },
      token: { id: 2, name: 'token' },
      usage: { promptTokens: 0, completionTokens: 0 },
      cost: { quota: 0 },
      request: { body: { input, ...body } },
      response: { status: 200, body: { id: crypto.randomUUID(), status: 'completed', output } },
    },
  };
}
async function insert(store: Ledger, env = envelope()) {
  const { id } = await store.ingest(Buffer.from(JSON.stringify(env)));
  const row = store.db
    .query<{ conversation_id: number | null; turn_index: number | null }, [number]>(
      'SELECT conversation_id,turn_index FROM requests WHERE id=?',
    )
    .get(id)!;
  return { id, conversation: row.conversation_id!, turn: row.turn_index! };
}
function withUsage(env: Envelope, usage: unknown, cost: unknown) {
  env.report.usage = usage;
  env.report.cost = cost;
  return env;
}
function bounded(value: unknown) {
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(65536);
}
function error(action: () => unknown, status: number) {
  try {
    action();
    throw new Error('expected API error');
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect((e as LedgerError).status).toBe(status);
  }
}
function remove(store: Ledger, id: number) {
  store.db.transaction(() =>
    (store as unknown as { deleteRoot(id: number): void }).deleteRoot(id),
  )();
}
function collect(store: Ledger, conversation: number, startTurn?: number) {
  const pages: FragmentPage[] = [];
  const all: Fragment[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const p = new URLSearchParams(
      cursor ? { cursor } : startTurn ? { startTurn: String(startTurn) } : {},
    );
    const page = fragments(store, conversation, p);
    bounded(page);
    pages.push(page);
    all.push(...page.fragments);
    if (page.cursor) {
      expect(cursors.has(page.cursor)).toBe(false);
      cursors.add(page.cursor);
      expect(page.fragments.length).toBeGreaterThan(0);
    }
    cursor = page.cursor;
    if (pages.length > 100) throw new Error('non-advancing pagination');
  } while (cursor);
  return { pages, all };
}
afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every new endpoint authenticates independently and sends no-store on errors and success', async () => {
  const store = fixture();
  const root = await insert(store);
  for (const endpoint of [
    'conversations',
    'detail',
    'branches',
    'subagents',
    'turns',
    'fragments',
    'text',
    'requests',
    'request',
    'lookup',
  ] as const) {
    const response = conversationHttp(
      new Request('http://local/?q=gateway-id'),
      store,
      endpoint,
      String(root.conversation),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    bounded(await response.json());
  }
  const response = conversationHttp(
    new Request('http://local/', {
      headers: {
        authorization: `Basic ${Buffer.from('admin:synthetic-admin-password').toString('base64')}`,
      },
    }),
    store,
    'conversations',
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  bounded(await response.json());
});

test('single-request metadata is authenticated, validates ids, and never restores evidence', async () => {
  const store = fixture();
  const root = await insert(store);
  const expected = requests(store, new URLSearchParams()).rows[0]!;
  const headers = {
    authorization: `Basic ${Buffer.from('admin:synthetic-admin-password').toString('base64')}`,
  };
  store.restore = () => {
    throw new Error('request metadata must not restore evidence');
  };
  const response = conversationHttp(
    new Request(`http://local/api/requests/${root.id}`, { headers }),
    store,
    'request',
    String(root.id),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(expected);
  expect(expected.incompleteReason).toBeNull();
  expect(expected.search).toBeNull();
  expect(requestDetail(store, root.id)).toEqual(expected);
  for (const invalid of ['', '0', '-1', '01', '1.5', '9007199254740992']) {
    const result = conversationHttp(
      new Request('http://local/api/requests/invalid', { headers }),
      store,
      'request',
      invalid,
    );
    expect(result.status).toBe(400);
    expect(result.headers.get('cache-control')).toBe('no-store');
  }
  const missing = conversationHttp(
    new Request('http://local/api/requests/999', { headers }),
    store,
    'request',
    '999',
  );
  expect(missing.status).toBe(404);
  expect(missing.headers.get('cache-control')).toBe('no-store');
  expect(await missing.json()).toEqual({ error: 'record_not_found' });
});

test('search projections serialize attached coordinates and fragment summaries at normalized item indexes', async () => {
  const store = fixture();
  const consumer = await insert(
    store,
    envelope(
      [
        { role: 'user', content: 'search request' },
        { type: 'function_call_output', call_id: 'call-search', output: 'result text' },
      ],
      undefined,
      { instructions: 'synthetic instructions' },
    ),
  );
  const search = await insert(store, envelope([], [], {}, 'openai_alpha_search'));
  const summary = { operations: [{ kind: 'search' as const, text: 'test query' }], resultCount: 3 };
  // Isolate API projection from evidence matching, which has separate integration tests.
  store.db
    .query('UPDATE requests SET search_summary=? WHERE id=?')
    .run(JSON.stringify(summary), search.id);
  store.db
    .query('INSERT INTO search_links VALUES(?,?,?,?,?)')
    .run(search.id, consumer.id, 2, 0, 'call-search');
  store.db.query('UPDATE conversations SET search_count=1 WHERE id=?').run(consumer.conversation);
  const restore = store.restore;
  store.restore = () => {
    throw new Error('metadata must not restore evidence');
  };
  expect(requestDetail(store, search.id).search).toEqual({
    ...summary,
    linked: { conversationId: consumer.conversation, turnIndex: consumer.turn },
  });
  expect(requests(store, new URLSearchParams()).rows[0]!.search).toEqual(
    requestDetail(store, search.id).search,
  );
  expect(conversationDetail(store, consumer.conversation).conversation.searchCount).toBe(1);
  store.restore = restore;
  const all = collect(store, consumer.conversation).all;
  const header = all.find((f) => f.type === 'message' && f.messageId === `${consumer.id}:input:2`);
  expect(header?.type === 'message' && header.searches).toEqual([
    { recordId: search.id, ...summary },
  ]);
  expect(
    all
      .filter((f) => f.type === 'message' && f.searches)
      .map((f) => f.type === 'message' && f.kind),
  ).toEqual(['tool_result']);
});

test('maximal escaped search summaries page within the JSON byte limit without losing metadata', async () => {
  const store = fixture();
  const summary = {
    operations: Array.from({ length: 20 }, () => ({
      kind: 'search' as const,
      text: '\u0000'.repeat(200),
    })),
    resultCount: 0,
  };
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const row = await insert(store, envelope([], [], {}, 'openai_alpha_search'));
    ids.push(row.id);
    store.db
      .query('UPDATE requests SET search_summary=? WHERE id=?')
      .run(JSON.stringify(summary), row.id);
  }
  const found: number[] = [];
  let cursor: string | null = null;
  do {
    const page = requests(store, new URLSearchParams(cursor ? { cursor } : {}));
    bounded(page);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThan(5);
    for (const row of page.rows) {
      expect(row.search).toEqual({ ...summary, linked: null });
      found.push(row.recordId);
    }
    cursor = page.cursor;
  } while (cursor);
  expect(found).toEqual(ids.reverse());
  const consumer = await insert(
    store,
    envelope([
      { type: 'function_call_output', call_id: 'many-searches', output: 'synthetic output' },
    ]),
  );
  for (const [part, searchId] of ids.slice(0, 3).entries()) {
    store.db
      .query('INSERT INTO search_links VALUES(?,?,?,?,?)')
      .run(searchId, consumer.id, 0, part, 'many-searches');
  }
  error(() => fragments(store, consumer.conversation, new URLSearchParams()), 413);
});

test('stored incomplete reasons appear in request rows, turn summaries and fragment headers', async () => {
  const store = fixture();
  for (const reason of ['truncated', 'no_terminal', null] as const) {
    const row = await insert(store);
    store.db.query('UPDATE requests SET incomplete_reason=? WHERE id=?').run(reason, row.id);
    expect(requestDetail(store, row.id).incompleteReason).toBe(reason);
    expect(turns(store, row.conversation, new URLSearchParams()).turns[0]!.incompleteReason).toBe(
      reason,
    );
    const header = collect(store, row.conversation).all.find((f) => f.type === 'turn');
    expect(header?.type === 'turn' && header.turn.incompleteReason).toBe(reason);
  }
});

test('gateway report statistics project across Responses, Chat, Claude and Gemini views', async () => {
  const store = fixture();
  const cases = [
    {
      format: 'openai_responses',
      request: { input: [{ role: 'user', content: 'Responses input' }] },
      response: {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
        ],
      },
      usage: {
        promptTokens: 100,
        completionTokens: 5,
        inputTokensTotal: 120,
        cacheTokens: 80,
        imageCacheTokens: 20,
        cacheWriteTokens: 30,
        cacheCreationTokens: 30,
        cacheCreationTokens12h: 20,
      },
      expected: { cacheReadTokens: 80, cacheWriteTokens: 30, inputTotalTokens: 120 },
    },
    {
      format: 'openai',
      request: { messages: [{ role: 'user', content: 'Chat input' }] },
      response: {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      },
      usage: {
        promptTokens: 100,
        completionTokens: 5,
        cacheTokens: 90,
        cacheCreationTokens: 30,
        cacheCreationTokens12h: 20,
      },
      expected: { cacheReadTokens: 90, cacheWriteTokens: 30, inputTotalTokens: 100 },
    },
    {
      format: 'claude',
      request: { messages: [{ role: 'user', content: 'Claude input' }] },
      response: {
        type: 'message',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      },
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        cacheTokens: 80,
        cacheCreationTokens: 15,
        cacheCreationTokens5m: 5,
        cacheCreationTokens1h: 15,
      },
      expected: { cacheReadTokens: 80, cacheWriteTokens: 20, inputTotalTokens: 110 },
    },
    {
      format: 'gemini',
      request: { contents: [{ role: 'user', parts: [{ text: 'Gemini input' }] }] },
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
      usage: { promptTokens: 100, completionTokens: 5, cacheTokens: 75 },
      expected: { cacheReadTokens: 75, cacheWriteTokens: 0, inputTotalTokens: 100 },
    },
  ];
  for (const entry of cases) {
    const env = withUsage(envelope([], [], {}, entry.format), entry.usage, {
      quota: 75,
      usd: 0.015,
    });
    env.report.request = { body: entry.request };
    env.report.response = { status: 200, body: entry.response };
    const inserted = await insert(store, env);
    const expected = { ...entry.expected, chargeUsd: 0.015, charge: 75 };
    expect(
      requests(store, new URLSearchParams()).rows.find((r) => r.recordId === inserted.id),
    ).toMatchObject(expected);
    expect(conversationDetail(store, inserted.conversation).conversation).toMatchObject(expected);
    expect(turns(store, inserted.conversation, new URLSearchParams()).turns[0]).toMatchObject(
      expected,
    );
    const header = collect(store, inserted.conversation).all.find((entry) => entry.type === 'turn');
    expect(header?.turn).toMatchObject(expected);
  }
});

test('OpenAI and Gemini infer zero writes only from valid cache reads with every write field omitted', async () => {
  const store = fixture();
  const cases = [
    { format: 'openai', usage: { cacheTokens: 0 }, write: 0 },
    { format: 'openai_responses', usage: { cacheTokens: 25 }, write: 0 },
    { format: 'gemini', usage: { promptTokens: 100 }, write: null },
    { format: 'openai', usage: null, write: null },
    { format: 'openai', usage: { cacheTokens: 0, cacheWriteTokens: null }, write: null },
    {
      format: 'openai_responses',
      usage: { cacheTokens: 25, cacheCreationTokens12h: 5 },
      write: null,
    },
    { format: 'gemini', usage: { cacheTokens: '25' }, write: null },
    { format: 'claude', usage: { cacheTokens: 0 }, write: null },
  ];
  for (const { format, usage, write } of cases) {
    const { id } = await insert(store, withUsage(envelope([], [], {}, format), usage, null));
    const request = requests(store, new URLSearchParams()).rows.find((row) => row.recordId === id);
    expect(request?.cacheWriteTokens).toBe(write);
  }
});

test('usage preserves explicit zero, missing values and explicit totals from converted records', async () => {
  const store = fixture();
  const zero = await insert(
    store,
    withUsage(
      envelope(),
      { promptTokens: 0, cacheTokens: 0, cacheWriteTokens: 0 },
      { quota: 0, usd: 0 },
    ),
  );
  const unknown = await insert(
    store,
    withUsage(
      envelope([], [], {}, 'claude'),
      { promptTokens: 15, cacheTokens: 2, cacheCreationTokens12h: 1 },
      { quota: 30 },
    ),
  );
  const converted = await insert(
    store,
    withUsage(
      envelope([], [], {}, 'openai'),
      { promptTokens: 15, cacheTokens: 50, cacheCreationTokens: 10, inputTokensTotal: 75 },
      null,
    ),
  );
  const missing = await insert(store, withUsage(envelope([], [], {}, 'unknown'), null, null));
  const invalid = await insert(
    store,
    withUsage(
      envelope(),
      { promptTokens: -1, cacheTokens: 1.5, cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1 },
      { usd: '0.01' },
    ),
  );
  const rows = requests(store, new URLSearchParams()).rows;
  expect(rows.find((r) => r.recordId === zero.id)).toMatchObject({
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTotalTokens: 0,
    chargeUsd: 0,
  });
  expect(rows.find((r) => r.recordId === unknown.id)).toMatchObject({
    cacheReadTokens: 2,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
  });
  expect(rows.find((r) => r.recordId === converted.id)).toMatchObject({
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    inputTotalTokens: 75,
    chargeUsd: null,
  });
  expect(rows.find((r) => r.recordId === missing.id)).toMatchObject({
    conversationId: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
  });
  expect(rows.find((r) => r.recordId === invalid.id)).toMatchObject({
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
  });
});

test('conversation usage totals count failed and superseded own turns and recover after unknown turns expire', async () => {
  const store = fixture();
  const user = { role: 'user', content: 'first input' };
  const assistant = { role: 'assistant', content: 'answer' };
  const next = { role: 'user', content: 'continue' };
  const measured = { promptTokens: 20, cacheTokens: 10, cacheWriteTokens: 2 };
  const root = await insert(store, withUsage(envelope([user]), measured, { quota: 100, usd: 0.1 }));
  const failure = withUsage(envelope([user, assistant, next]), measured, { quota: 200, usd: 0.2 });
  failure.report.error = { status: 502 };
  const fail = await insert(store, failure);
  const success = await insert(
    store,
    withUsage(envelope([user, assistant, next]), measured, { quota: 300, usd: 0.3 }),
  );
  const branch = await insert(
    store,
    withUsage(envelope([user, assistant, { ...next, content: 'edit' }]), measured, {
      quota: 400,
      usd: 0.4,
    }),
  );
  expect(fail.conversation).toBe(root.conversation);
  expect(success.conversation).toBe(root.conversation);
  expect(turns(store, root.conversation, new URLSearchParams()).turns[1]).toMatchObject({
    completeness: 'error',
    superseded: true,
  });
  const branchRow = conversationDetail(store, branch.conversation).conversation;
  expect(branchRow).toMatchObject({
    ownTurns: 1,
    inheritedTurns: 1,
    cacheReadTokens: 10,
    cacheWriteTokens: 2,
    inputTotalTokens: 20,
    charge: 400,
    chargeUsd: 0.4,
    chargePartial: false,
  });

  const last = await insert(
    store,
    withUsage(
      envelope([user, assistant, next, assistant, { ...next, content: 'third input' }]),
      { promptTokens: 20 },
      { quota: 0 },
    ),
  );
  expect(last.conversation).toBe(root.conversation);
  const partial = conversationDetail(store, root.conversation).conversation;
  expect(partial).toMatchObject({
    ownTurns: 4,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: 80,
    charge: 600,
    chargeUsd: null,
    chargePartial: true,
  });
  remove(store, last.id);
  const recovered = conversationDetail(store, root.conversation).conversation;
  expect(recovered).toMatchObject({
    ownTurns: 3,
    cacheReadTokens: 30,
    cacheWriteTokens: 6,
    inputTotalTokens: 60,
    charge: 600,
    chargePartial: false,
  });
  expect(recovered.chargeUsd).toBeCloseTo(0.6);
  remove(store, root.id);
  const trimmed = conversationDetail(store, root.conversation).conversation;
  expect(trimmed).toMatchObject({
    ownTurns: 2,
    cacheReadTokens: 20,
    cacheWriteTokens: 4,
    inputTotalTokens: 40,
    charge: 500,
    chargePartial: false,
  });
  expect(trimmed.chargeUsd).toBeCloseTo(0.5);
});

test('retention clears rounding residue after the last known USD charge is removed', async () => {
  const store = fixture();
  const put = (usd: number | null) => {
    const env = envelope([{ role: 'user', content: crypto.randomUUID() }], undefined, {
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'retained-usage' }) },
    });
    env.report.cost = usd === null ? null : { quota: usd * 500_000, usd };
    return insert(store, env);
  };
  const a = await put(0.1);
  const b = await put(0.2);
  const unknown = await put(null);
  expect(unknown.conversation).toBe(a.conversation);
  remove(store, a.id);
  remove(store, b.id);
  expect(conversationDetail(store, a.conversation).conversation.chargeUsd).toBeNull();
  const zero = await put(0);
  expect(zero.conversation).toBe(a.conversation);
  remove(store, unknown.id);
  expect(conversationDetail(store, a.conversation).conversation.chargeUsd).toBe(0);
});

test('cost pages order fractional quota ties, zero and unknown, and scope cursors to sort and filters', async () => {
  const store = fixture();
  const put = async (quota: number | null) => {
    const env = envelope([{ role: 'user', content: crypto.randomUUID() }]);
    env.report.cost = quota === null ? null : { quota, usd: quota / 500_000 };
    return (await insert(store, env)).conversation;
  };
  const high = await put(20.5);
  const olderTie = await put(10.5);
  const oldUnknown = await put(null);
  const zero = await put(0);
  const newerTie = await put(10.5);
  const newUnknown = await put(null);
  const seen: number[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ sort: 'cost', limit: '1' });
    if (cursor) params.set('cursor', cursor);
    const response = conversationHttp(
      new Request(`http://local/api/conversations?${params}`, {
        headers: {
          authorization: `Basic ${Buffer.from('admin:synthetic-admin-password').toString('base64')}`,
        },
      }),
      store,
      'conversations',
    );
    expect(response.status).toBe(200);
    const page: ConversationList = await response.json();
    expect(page.rows).toHaveLength(1);
    seen.push(page.rows[0]!.id);
    expect(seen.length).toBeLessThanOrEqual(6);
    cursor = page.cursor;
  } while (cursor);
  expect(seen).toEqual([high, newerTie, olderTie, zero, newUnknown, oldUnknown]);
  const recent = conversations(store, new URLSearchParams({ limit: '1' }));
  const cost = conversations(store, new URLSearchParams({ sort: 'cost', limit: '1' }));
  expect(recent.rows[0]?.id).toBe(newUnknown);
  error(() => conversations(store, new URLSearchParams({ sort: 'expense' })), 400);
  error(
    () => conversations(store, new URLSearchParams({ sort: 'recent', cursor: cost.cursor! })),
    400,
  );
  error(
    () => conversations(store, new URLSearchParams({ sort: 'cost', cursor: recent.cursor! })),
    400,
  );
  error(
    () =>
      conversations(
        store,
        new URLSearchParams({ sort: 'cost', user: 'someone', cursor: cost.cursor! }),
      ),
    400,
  );
});

test('lists preserve zero versus null, filters, activity overlap, opaque scope and deterministic order', async () => {
  const store = fixture();
  const a = await insert(store);
  const other = envelope([{ role: 'user', content: 'different' }]);
  other.report.cost = null;
  other.report.user = { id: 3, username: 'other' };
  const b = await insert(store, other);
  store.db.query('UPDATE conversations SET first_at=0,last_at=100 WHERE id=?').run(a.conversation);
  store.db.query('UPDATE conversations SET first_at=50,last_at=100 WHERE id=?').run(b.conversation);
  const page = conversations(store, new URLSearchParams({ limit: '1' }));
  expect(page.rows[0]!.id).toBe(b.conversation);
  expect(page.rows[0]!.charge).toBeNull();
  expect(page.cursor).toBeString();
  const next = conversations(store, new URLSearchParams({ limit: '1', cursor: page.cursor! }));
  expect(next.rows[0]!.id).toBe(a.conversation);
  expect(next.rows[0]!.charge).toBe(0);
  expect(next.rows[0]!.inputTokens).toBe(0);
  expect(next.cursor).toBeNull();
  expect(
    conversations(store, new URLSearchParams({ from: '0', to: '0' })).rows.map((r) => r.id),
  ).toEqual([a.conversation]);
  expect(
    conversations(
      store,
      new URLSearchParams({ user: 'user', token: 'token', model: 'model', status: 'complete' }),
    ).rows.map((r) => r.id),
  ).toEqual([a.conversation]);
  error(
    () => conversations(store, new URLSearchParams({ user: 'other', cursor: page.cursor! })),
    400,
  );
  const invalidParams: Record<string, string>[] = [
    { limit: '0' },
    { limit: '51' },
    { from: '-1' },
    { from: '2', to: '1' },
    { status: 'future' },
    { kind: 'future' },
    { from: '1e3' },
    { user: '' },
  ];
  for (const params of invalidParams)
    error(() => conversations(store, new URLSearchParams(params)), 400);
  const requestPage = requests(store, new URLSearchParams({ limit: '1' }));
  expect(requestPage.rows.length).toBe(1);
  expect(requestPage.cursor).toBeString();
  bounded(requestPage);
  error(() => requests(store, new URLSearchParams({ cursor: page.cursor! })), 400);
});

test('lookup is exact, returns multiple candidates newest first, including non-conversation requests', async () => {
  const store = fixture();
  const a = await insert(store);
  const b = await insert(store, envelope([], [], {}, 'openai_alpha_search'));
  const result = lookup(store, new URLSearchParams({ q: 'gateway-id' }));
  expect(result.candidates.map((c) => c.recordId)).toEqual([b.id, a.id]);
  expect(result.candidates[0]!.conversationId).toBeNull();
  expect(lookup(store, new URLSearchParams({ q: 'gateway' })).candidates).toEqual([]);
  bounded(result);
  error(() => lookup(store, new URLSearchParams()), 400);
});

test('text and canonical JSON parts continue for at least three chunks without gaps or overlap', async () => {
  const store = fixture();
  const text = '😀中\u0000\\"'.repeat(9000);
  const json = { z: '😀\u0001'.repeat(12000), a: [1, 2, { nested: 'value' }] };
  const root = await insert(
    store,
    envelope(
      [{ role: 'user', content: text }],
      [{ type: 'function_call', name: 'tool', call_id: 'call', arguments: json }],
    ),
  );
  const { all } = collect(store, root.conversation);
  const chunks = all.filter((f): f is Extract<Fragment, { type: 'chunk' }> => f.type === 'chunk');
  expect(chunks.length).toBe(2);
  for (const first of chunks) {
    let reconstructed = first.text;
    let count = 1;
    let token = first.continuation;
    let offset = first.nextOffset;
    while (token) {
      const chunk = textContinuation(store, token);
      bounded(chunk);
      expect(chunk.offset).toBe(offset!);
      expect(chunk.messageId).toBe(first.messageId);
      reconstructed += chunk.text;
      offset = chunk.nextOffset;
      token = chunk.continuation;
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(3);
    expect(offset).toBeNull();
    expect(reconstructed).toBe(first.partKind === 'json' ? canonicalJson(json) : text);
  }
  const token = chunks[0]!.continuation!;
  error(() => textContinuation(store, `${token.slice(0, -1)}!`), 400);
  remove(store, root.id);
  error(() => textContinuation(store, token), 404);
});

test('many-part, huge-turn and header-only descriptor pages advance once and emit only first part chunks', async () => {
  const store = fixture();
  const output = [
    ...Array.from({ length: 45 }, (_, i) => ({
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: `${i}:${'\u0000😀'.repeat(9000)}` },
        { type: 'output_text', text: 'second' },
      ],
    })),
    ...Array.from({ length: 220 }, () => ({ type: 'reasoning', summary: [] })),
    { type: 'future_unknown', data: { raw: 'never execute' } },
  ];
  const root = await insert(store, envelope([{ role: 'user', content: 'hello' }], output));
  const { pages, all } = collect(store, root.conversation);
  expect(pages.length).toBeGreaterThan(5);
  const headers = all.filter(
    (f): f is Extract<Fragment, { type: 'message' }> => f.type === 'message',
  );
  expect(headers.some((h) => h.partCount === 0)).toBe(true);
  expect(headers.some((h) => h.kind === 'other')).toBe(true);
  expect(new Set(headers.map((h) => h.messageId)).size).toBe(headers.length);
  const ranges = all.flatMap((f) =>
    f.type === 'chunk' ? [`${f.messageId}/${f.partIndex}/${f.offset}`] : [],
  );
  expect(new Set(ranges).size).toBe(ranges.length);
  expect(all.every((f) => f.type !== 'chunk' || f.offset === 0)).toBe(true);
  expect(all.filter((f) => f.type === 'turn').length).toBe(1);
});

test('turns locate startTurn directly, prefix inherited input is hidden and leading history is flagged', async () => {
  const store = fixture();
  const input = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first' },
  ];
  const output = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] },
  ];
  const a = await insert(store, envelope(input, output));
  const b = await insert(
    store,
    envelope([
      ...input,
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]),
  );
  expect(b.conversation).toBe(a.conversation);
  const first = collect(store, a.conversation, a.turn).all;
  expect(first.some((f) => f.type === 'message' && f.leadingHistory)).toBe(true);
  const selected = collect(store, a.conversation, b.turn).all;
  expect(selected.filter((f) => f.type === 'turn').map((f) => f.turn.recordId)).toEqual([b.id]);
  expect(selected.filter((f) => f.type === 'chunk').map((f) => f.text)).toEqual([
    'second',
    'answer',
  ]);
  const page = turns(store, a.conversation, new URLSearchParams({ limit: '1' }));
  expect(page.cursor).toBeString();
  expect(
    turns(store, a.conversation, new URLSearchParams({ cursor: page.cursor! })).turns[0]!.recordId,
  ).toBe(b.id);
  error(() => turns(store, a.conversation, new URLSearchParams({ startTurn: '999' })), 404);
  error(() => fragments(store, a.conversation, new URLSearchParams({ startTurn: '999' })), 404);
  error(() => turns(store, a.conversation, new URLSearchParams({ startTurn: '0' })), 400);
  remove(store, a.id);
  expect(
    collect(store, a.conversation, b.turn)
      .all.filter((f) => f.type === 'chunk')
      .map((f) => f.text),
  ).toEqual(['second', 'answer']);
  error(
    () => turns(store, a.conversation, new URLSearchParams({ startTurn: String(a.turn) })),
    404,
  );
});

test('detail exposes the last existing turn and fromTurn starts at the next existing turn', async () => {
  const store = fixture();
  let history: unknown[] = [];
  const inserted: { id: number; conversation: number; turn: number }[] = [];
  for (let index = 1; index <= 4; index++) {
    history = [...history, { role: 'user', content: `turn ${index}` }];
    inserted.push(await insert(store, envelope(history)));
    history = [...history, { role: 'assistant', content: 'answer' }];
  }
  const conversation = inserted[0]!.conversation;
  expect(inserted.every((row) => row.conversation === conversation)).toBe(true);
  expect(conversationDetail(store, conversation).lastTurnIndex).toBe(4);
  const firstTurn = (params: Record<string, string>) =>
    fragments(store, conversation, new URLSearchParams(params)).fragments.find(
      (f) => f.type === 'turn',
    );
  // Retention leaves a gap: exact startTurn reports it, fromTurn moves on to the next turn.
  remove(store, inserted[1]!.id);
  error(() => fragments(store, conversation, new URLSearchParams({ startTurn: '2' })), 404);
  expect(firstTurn({ fromTurn: '2' })).toMatchObject({ turn: { turnIndex: 3 } });
  expect(firstTurn({ fromTurn: '1' })).toMatchObject({ turn: { turnIndex: 1 } });
  expect(fragments(store, conversation, new URLSearchParams({ fromTurn: '9' }))).toEqual({
    fragments: [],
    cursor: null,
  });
  error(() => fragments(store, conversation, new URLSearchParams({ fromTurn: '0' })), 400);
  error(
    () => fragments(store, conversation, new URLSearchParams({ fromTurn: '1', startTurn: '1' })),
    400,
  );
  error(
    () => fragments(store, conversation, new URLSearchParams({ fromTurn: '1', cursor: 'x' })),
    400,
  );
  expect(
    turns(store, conversation, new URLSearchParams({ fromTurn: '2' })).turns.map(
      (t) => t.turnIndex,
    ),
  ).toEqual([3, 4]);
  remove(store, inserted[3]!.id);
  expect(conversationDetail(store, conversation).lastTurnIndex).toBe(3);
});

test('declared reset markers, branch metadata and direct subagent lists remain distinct', async () => {
  const store = fixture();
  const identity = (thread: string, window: string, parent?: string) => ({
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: thread,
        session_id: 'session',
        window_id: window,
        ...(parent
          ? { parent_thread_id: parent, agent_name: 'worker', subagent_kind: 'task' }
          : {}),
      }),
    },
  });
  const a = await insert(store, envelope(undefined, undefined, identity('main', 'one')));
  const reset = await insert(
    store,
    envelope([{ role: 'user', content: 'compressed' }], undefined, identity('main', 'two')),
  );
  expect(reset.conversation).toBe(a.conversation);
  const child = await insert(
    store,
    envelope([{ role: 'user', content: 'child' }], undefined, identity('child', 'one', 'main')),
  );
  const detail = conversationDetail(store, a.conversation);
  expect(detail.subagentCount).toBe(1);
  expect(detail.subagentsPreview[0]!.id).toBe(child.conversation);
  expect(conversationDetail(store, child.conversation).subagentOf).toEqual({
    id: a.conversation,
    title: detail.conversation.title,
    removed: false,
  });
  expect(
    relations(store, a.conversation, new URLSearchParams(), 'subagents').rows[0]!.agentName,
  ).toBe('worker');
  expect(
    conversations(store, new URLSearchParams({ kind: 'subagent' })).rows.map((r) => r.id),
  ).toEqual([child.conversation]);
  expect(collect(store, a.conversation, reset.turn).all[0]).toEqual({
    type: 'reset',
    turnIndex: reset.turn,
    reason: 'window_changed',
  });
  bounded(detail);
});

test('branch detail retains origin-turn tombstones and scoped cursor rejects another conversation', async () => {
  const store = fixture();
  const input = [{ role: 'user', content: 'root' }];
  const a = await insert(store, envelope(input));
  const history = [...input, { role: 'assistant', content: 'answer' }];
  const b = await insert(store, envelope([...history, { role: 'user', content: 'first' }]));
  const c = await insert(store, envelope([...history, { role: 'user', content: 'fork' }]));
  expect(b.conversation).toBe(a.conversation);
  expect(c.conversation).not.toBe(a.conversation);
  expect(conversationDetail(store, a.conversation).branchesPreview).toEqual([
    { id: c.conversation, title: 'fork', atTurn: a.turn },
  ]);
  const d = conversationDetail(store, c.conversation);
  expect(d.forkedFrom?.removed).toBe(false);
  const page = fragments(store, a.conversation, new URLSearchParams());
  // Force a real cursor by many turn summaries, with a cursor explicitly scoped to the source.
  const turnPage = turns(store, a.conversation, new URLSearchParams({ limit: '1' }));
  error(() => turns(store, c.conversation, new URLSearchParams({ cursor: turnPage.cursor! })), 400);
  bounded(page);
  remove(store, a.id);
  expect(conversationDetail(store, c.conversation).forkedFrom?.removed).toBe(true);
});

test('declared direct subagent counts belong only to the primary conversation', async () => {
  const store = fixture();
  const identity = (thread: string, parent?: string) => ({
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: thread,
        session_id: 'session',
        parent_thread_id: parent,
      }),
    },
  });
  const input = [{ role: 'user', content: 'root' }];
  const root = await insert(store, envelope(input, undefined, identity('main')));
  const history = [...input, { role: 'assistant', content: 'answer' }];
  await insert(
    store,
    envelope([...history, { role: 'user', content: 'first' }], undefined, identity('main')),
  );
  const branch = await insert(
    store,
    envelope([...history, { role: 'user', content: 'fork' }], undefined, identity('main')),
  );
  const child = await insert(
    store,
    envelope([{ role: 'user', content: 'child' }], undefined, identity('child', 'main')),
  );
  const primary = conversationDetail(store, root.conversation);
  expect(primary.subagentCount).toBe(1);
  expect(primary.subagentsPreview.map((row) => row.id)).toEqual([child.conversation]);
  const fork = conversationDetail(store, branch.conversation);
  expect(fork.subagentCount).toBe(0);
  expect(fork.conversation.subagentCount).toBe(0);
  expect(fork.subagentsPreview).toEqual([]);
  const rows = conversations(store, new URLSearchParams()).rows;
  expect(rows.find((row) => row.id === root.conversation)!.subagentCount).toBe(1);
  expect(rows.find((row) => row.id === branch.conversation)!.subagentCount).toBe(0);
  expect(
    relations(store, root.conversation, new URLSearchParams(), 'branches').rows[0]!.subagentCount,
  ).toBe(0);
});

test('image display exposes ordered placeholders and plain URL text without changing restored evidence', async () => {
  const store = fixture();
  const url = 'https://example.invalid/picture?<escaped>';
  const env = envelope([
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: url, detail: 'high' },
        { type: 'input_text', text: 'after' },
      ],
    },
  ]);
  const original = Buffer.from(JSON.stringify(env));
  const root = await insert(store, env);
  const all = collect(store, root.conversation).all;
  const header = all.find((f) => f.type === 'message' && f.side === 'input');
  expect(header && header.type === 'message' && header.media).toEqual({ label: '图片' });
  const chunks = all.filter((f) => f.type === 'chunk' && f.messageId === `${root.id}:input:0`);
  expect(chunks.map((f) => f.type === 'chunk' && f.text)).toEqual([
    'before',
    '[图片]',
    url,
    'after',
  ]);
  expect(chunks.every((f) => f.type === 'chunk' && f.partKind === 'text')).toBe(true);
  expect(store.restore(root.id)).toEqual(original);
});

test('UTF-8 budget bounds escaping-heavy list metadata and rejects oversize standalone data', async () => {
  const store = fixture();
  for (let i = 0; i < 20; i++) {
    const env = envelope([{ role: 'user', content: `${i}${'\u0000'.repeat(300)}` }]);
    env.context.model = '\u0000'.repeat(256);
    env.report.user = { id: i, username: '\u0000'.repeat(256) };
    env.report.token = { id: 2, name: '\u0000'.repeat(256) };
    await insert(store, env);
  }
  const p = conversations(store, new URLSearchParams());
  bounded(p);
  expect(p.rows.length).toBeLessThan(20);
  expect(p.cursor).toBeString();
  const q = requests(store, new URLSearchParams());
  bounded(q);
  expect(q.cursor).toBeString();
  error(() => boundedJson({ text: '\u0000'.repeat(20000) }), 413);
});

test('upload projection preserves all active states while bounding maximal escaped hints and terminal receipts', () => {
  const hint = {
    request_id: '\u0000'.repeat(256),
    context: { format: '\u0000'.repeat(256), model: '\u0000'.repeat(256) },
  };
  const uploads = Array.from({ length: 116 }, (_, index) => ({
    upload_id: String(index),
    state: index < 100 ? 'complete' : 'partial',
    hint,
    hint_verified: false,
  }));
  const result = boundedUploads({ uploads });
  bounded(result);
  expect(result.omitted).toBeGreaterThan(0);
  expect(result.uploads.filter((row) => row.state === 'partial').length).toBe(16);
  expect(result.uploads.every((row) => row.hint_verified === false)).toBe(true);
});

test('status filters include media and any own error/partial turn, request rows retain nullable charges', async () => {
  const store = fixture();
  const media = envelope([
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.invalid/never-fetch' }],
    },
  ]);
  media.report.request = { ...(media.report.request as object), media: [{ label: 'image' }] };
  const m = await insert(store, media);
  const failed = envelope([{ role: 'user', content: 'failure' }]);
  (failed.report.response as Record<string, unknown>).status = 500;
  failed.report.cost = null;
  const e = await insert(store, failed);
  const partial = envelope([{ role: 'user', content: 'partial' }]);
  (partial.report.response as Record<string, unknown>).truncated = true;
  const p = await insert(store, partial);
  expect(
    conversations(store, new URLSearchParams({ status: 'media' })).rows.map((r) => r.id),
  ).toEqual([m.conversation]);
  expect(
    conversations(store, new URLSearchParams({ status: 'error' })).rows.map((r) => r.id),
  ).toEqual([e.conversation]);
  expect(
    conversations(store, new URLSearchParams({ status: 'partial' })).rows.map((r) => r.id),
  ).toEqual([p.conversation]);
  const errorRows = requests(
    store,
    new URLSearchParams({
      status: 'error',
      request: 'gateway-id',
      user: 'user',
      token: 'token',
      model: 'model',
    }),
  ).rows;
  expect(errorRows.map((r) => r.recordId)).toEqual([e.id]);
  expect(errorRows[0]!.charge).toBeNull();
  expect(requests(store, new URLSearchParams({ status: 'media' })).rows[0]!.charge).toBe(0);
});

test('turn summaries expose stored protocol stop reasons without restoring evidence', async () => {
  const store = fixture();
  const env = envelope([], [], {}, 'gemini');
  env.report.request = {
    body: { contents: [{ role: 'user', parts: [{ text: 'synthetic limit' }] }] },
  };
  env.report.response = {
    status: 200,
    body: {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'captured' }] }, finishReason: 'MAX_TOKENS' },
      ],
    },
  };
  const root = await insert(store, env);
  expect(turns(store, root.conversation, new URLSearchParams()).turns[0]!.stopReason).toBe(
    'MAX_TOKENS',
  );
});

test('retry turns retain failed attempts, terminal status filters clear after success, historical request errors remain', async () => {
  const store = fixture();
  const input = [{ role: 'user', content: 'repeat this exact input' }];
  const declared = {
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'api-retry-thread' }) },
  };
  const fail = () => {
    const env = envelope(input, [], declared);
    (env.report.response as Record<string, unknown>).status = 502;
    return env;
  };
  const first = await insert(store, fail());
  const second = await insert(store, fail());
  expect(second.conversation).toBe(first.conversation);
  expect(
    conversations(store, new URLSearchParams({ status: 'error' })).rows.map((row) => row.id),
  ).toEqual([first.conversation]);
  const last = await insert(store, envelope(input, undefined, declared));
  expect(last.conversation).toBe(first.conversation);
  const page = turns(store, first.conversation, new URLSearchParams());
  bounded(page);
  expect(
    page.turns.map((turn) => ({
      record: turn.recordId,
      retryOf: turn.retryOf,
      superseded: turn.superseded,
      completeness: turn.completeness,
    })),
  ).toEqual([
    { record: first.id, retryOf: null, superseded: true, completeness: 'error' },
    { record: second.id, retryOf: first.turn, superseded: true, completeness: 'error' },
    { record: last.id, retryOf: second.turn, superseded: false, completeness: 'complete' },
  ]);
  expect(conversations(store, new URLSearchParams({ status: 'error' })).rows).toEqual([]);
  expect(conversations(store, new URLSearchParams({ status: 'partial' })).rows).toEqual([]);
  const row = conversations(store, new URLSearchParams()).rows[0]!;
  expect(row.hasError).toBe(false);
  expect(row.hasPartial).toBe(false);
  expect(row.ownTurns).toBe(3);
  expect(
    requests(store, new URLSearchParams({ status: 'error' })).rows.map((row) => row.recordId),
  ).toEqual([second.id, first.id]);
  const partial = envelope(input, [], declared);
  (partial.report.response as Record<string, unknown>).truncated = true;
  const latest = await insert(store, partial);
  expect(latest.conversation).toBe(first.conversation);
  expect(
    conversations(store, new URLSearchParams({ status: 'partial' })).rows.map((row) => row.id),
  ).toEqual([first.conversation]);
  expect(conversations(store, new URLSearchParams({ status: 'error' })).rows).toEqual([]);
  expect(
    collect(store, first.conversation).all.filter((fragment) => fragment.type === 'turn').length,
  ).toBe(4);
});

test('retry metadata and list titles use persisted projections without restoring request evidence', async () => {
  const store = fixture();
  const declared = {
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'metadata-retry-thread' }),
    },
  };
  const first = await insert(
    store,
    envelope([{ role: 'user', content: 'metadata title' }], undefined, declared),
  );
  const latest = await insert(
    store,
    envelope([{ role: 'user', content: 'metadata title' }], undefined, declared),
  );
  const restore = store.restore;
  store.restore = () => {
    throw new Error('metadata list must not restore evidence');
  };
  try {
    const summary = turns(store, first.conversation, new URLSearchParams()).turns;
    expect(summary[1]!.retryOf).toBe(first.turn);
    expect(summary[0]!.superseded).toBe(true);
    expect(conversations(store, new URLSearchParams()).rows[0]!.title).toBe('metadata title');
    expect(requests(store, new URLSearchParams()).rows.map((row) => row.recordId)).toEqual([
      latest.id,
      first.id,
    ]);
  } finally {
    store.restore = restore;
  }
});

test('read-only frozen shadow replay reduces synthetic historical branches and flags without changing source evidence or membership', async () => {
  const store = fixture();
  const input = [{ role: 'user', content: 'synthetic project plan' }];
  const root = await insert(store, envelope(input));
  const followup = [
    ...input,
    { role: 'assistant', content: 'answer' },
    { type: 'function_call_output', call_id: 'synthetic-call', output: 'synthetic tool result' },
  ];
  const failed = () => {
    const env = envelope(followup, []);
    (env.report.response as Record<string, unknown>).status = 502;
    return env;
  };
  await insert(store, failed());
  await insert(store, failed());
  await insert(store, envelope(followup));
  // Simulate the previous schema3 assignment projection, only in this disposable synthetic DB:
  // an error continues root1; the next error and the final success fork into empty-title branches.
  const columns = (
    store.db.query('PRAGMA table_info(conversations)').all() as { name: string }[]
  ).map((row) => row.name);
  for (const conversation of [2, 3]) {
    const expressions = columns.map(
      (column) =>
        ({
          id: String(conversation),
          title: "''",
          forked_from_conversation: String(root.conversation),
          forked_from_turn: String(root.turn),
        })[column] ?? column,
    );
    store.db.exec(
      `INSERT INTO conversations(${columns.join(',')}) SELECT ${expressions.join(',')} FROM conversations WHERE id=${root.conversation}`,
    );
  }
  store.db.exec(
    'UPDATE requests SET conversation_id=2,turn_index=1 WHERE id=3; UPDATE requests SET conversation_id=3,turn_index=1 WHERE id=4; PRAGMA user_version=3',
  );
  const assignments = store.db
    .query('SELECT id,conversation_id,turn_index FROM requests ORDER BY id')
    .all();
  const fingerprints = () =>
    ['', '-wal'].map((suffix) =>
      existsSync(store.config.database + suffix)
        ? hash(readFileSync(store.config.database + suffix))
        : null,
    );
  const before = fingerprints();
  const result = estimateRetry(store.config.database, 218);
  expect(result.before).toMatchObject({
    requests: 4,
    conversations: 3,
    branches: 2,
    emptyTitles: 2,
    red: 2,
    partial: 0,
  });
  expect(result.after).toMatchObject({
    requests: 4,
    conversations: 1,
    branches: 0,
    emptyTitles: 0,
    red: 0,
    partial: 0,
  });
  expect(result.verifiedRecords).toBe(4);
  expect(result.after.evidenceDigest).toBe(result.before.evidenceDigest);
  expect(fingerprints()).toEqual(before);
  expect(
    store.db.query('SELECT id,conversation_id,turn_index FROM requests ORDER BY id').all(),
  ).toEqual(assignments);
  expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  expect(JSON.stringify(result)).not.toContain('synthetic project plan');
  error(() => {
    try {
      estimateRetry(store.config.database, 217);
    } catch {
      throw new LedgerError(400, 'fixed_cutoff_required');
    }
  }, 400);
});

test('ordered partial prefix and announced item-id links retain echoed client output as incomplete-parent input', async () => {
  const store = fixture();
  const ids: Awaited<ReturnType<typeof insert>>[] = [];
  for (const env of partialLoopFixtures()) ids.push(await insert(store, env));
  expect(new Set(ids.map((row) => row.conversation)).size).toBe(1);
  const rows = store.db
    .query<
      {
        id: number;
        parent_id: number | null;
        parent_coverage: number;
        input_count: number;
        link_rule: string | null;
      },
      []
    >('SELECT id,parent_id,parent_coverage,input_count,link_rule FROM requests ORDER BY id')
    .all();
  expect(rows.map((row) => row.parent_id)).toEqual([null, ids[0]!.id, ids[1]!.id, ids[2]!.id]);
  expect(rows[1]!.parent_coverage).toBe(3);
  expect(rows[2]!.parent_coverage).toBe(rows[1]!.input_count);
  expect(rows[3]!.parent_coverage).toBe(rows[2]!.input_count);
  const page = turns(store, ids[0]!.conversation, new URLSearchParams());
  bounded(page);
  expect(page.turns.map((turn) => turn.parentOutputIncomplete)).toEqual([false, true, true, true]);
  const third = collect(store, ids[0]!.conversation, ids[2]!.turn).all;
  const thirdInput = third.filter(
    (fragment): fragment is Extract<Fragment, { type: 'message' }> =>
      fragment.type === 'message' &&
      fragment.turnIndex === ids[2]!.turn &&
      fragment.side === 'input',
  );
  expect(thirdInput.map((fragment) => fragment.kind)).toEqual(['tool_call', 'tool_result']);
  const thirdMessages = new Set(thirdInput.map((fragment) => fragment.messageId));
  const thirdText = third.flatMap((fragment) =>
    fragment.type === 'chunk' && thirdMessages.has(fragment.messageId) ? [fragment.text] : [],
  );
  expect(thirdText).toEqual(['{"step":2}', 'Synthetic tool result 42']);
  remove(store, ids[1]!.id);
  const after = collect(store, ids[0]!.conversation, ids[2]!.turn).all;
  expect(
    after.filter(
      (fragment) =>
        fragment.type === 'message' &&
        fragment.turnIndex === ids[2]!.turn &&
        fragment.side === 'input',
    ).length,
  ).toBe(2);
});

test('read-only schema4 partial forecast verifies evidence, metadata and source WAL while repairing the synthetic 41–44 split', async () => {
  const store = fixture();
  store.db.query('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('requests', 40);
  const ids: Awaited<ReturnType<typeof insert>>[] = [];
  for (const env of partialLoopFixtures()) ids.push(await insert(store, env));
  const columns = (
    store.db.query('PRAGMA table_info(conversations)').all() as { name: string }[]
  ).map((row) => row.name);
  const root = ids[0]!.conversation;
  const expressions = columns.map(
    (column) =>
      ({ id: '2', forked_from_conversation: String(root), forked_from_turn: '1' })[column] ??
      column,
  );
  store.db.exec(
    `INSERT INTO conversations(${columns.join(',')}) SELECT ${expressions.join(',')} FROM conversations WHERE id=${root}`,
  );
  store.db.exec(
    'UPDATE requests SET conversation_id=2,turn_index=1,parent_id=41,parent_coverage=0 WHERE id=42; UPDATE requests SET conversation_id=1,turn_index=2,parent_id=NULL,parent_coverage=0 WHERE id=43; UPDATE requests SET conversation_id=1,turn_index=3,parent_id=NULL,parent_coverage=0 WHERE id=44; PRAGMA user_version=4',
  );
  const assignments = store.db
    .query(
      'SELECT id,conversation_id,turn_index,parent_id,parent_coverage FROM requests ORDER BY id',
    )
    .all();
  const files = () =>
    ['', '-wal'].map((suffix) =>
      existsSync(store.config.database + suffix)
        ? hash(readFileSync(store.config.database + suffix))
        : null,
    );
  const before = files();
  const result = estimatePartial(store.config.database, 372);
  expect(result.before).toMatchObject({
    requests: 4,
    conversations: 2,
    branches: 1,
    emptyTitles: 0,
    red: 0,
    partial: 1,
  });
  expect(result.after).toMatchObject({
    requests: 4,
    conversations: 1,
    branches: 0,
    emptyTitles: 0,
    red: 0,
    partial: 0,
  });
  expect(result.selectedAfter.map((row) => row.id)).toEqual([41, 42, 43, 44]);
  expect(result.selectedAfter.map((row) => row.parentId)).toEqual([null, 41, 42, 43]);
  expect(result.selectedAfter.map((row) => row.parentCoverage)).toEqual([0, 3, 4, 6]);
  expect(result.before.evidenceDigest).toBe(result.after.evidenceDigest);
  expect(result.sourceMetadataDigest).toBe(result.verifiedSourceMetadataDigest);
  expect(files()).toEqual(before);
  expect(
    store.db
      .query(
        'SELECT id,conversation_id,turn_index,parent_id,parent_coverage FROM requests ORDER BY id',
      )
      .all(),
  ).toEqual(assignments);
  expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
  expect(JSON.stringify(result)).not.toContain('Synthetic ordered tool loop');
});
