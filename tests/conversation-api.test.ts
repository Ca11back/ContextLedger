import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../src/contracts';
import type { Fragment, FragmentPage } from '../src/conversation-contracts';
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
  requests,
  textContinuation,
  turns,
} from '../src/server/conversation-api';
import { LedgerError } from '../src/server/errors';
import { canonicalJson } from '../src/server/normalize';
import { Ledger } from '../src/server/storage';

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
