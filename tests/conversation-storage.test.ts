import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Envelope } from '../src/contracts';
import { hash } from '../src/server/codec';
import type { Config } from '../src/server/config';
import { requestIndexColumns } from '../src/server/linking';
import { statisticColumns } from '../src/server/statistics';
import { Ledger } from '../src/server/storage';

const stores: Ledger[] = [],
  dirs: string[] = [];
function config(): Config {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-conversations-'));
  dirs.push(dir);
  return {
    database: join(dir, 'audit.sqlite'),
    maxStorageBytes: 32_000_000,
    reserveBytes: 256_000,
    maxBodyBytes: 1_048_576,
    source: 'synthetic',
    adminUser: 'admin',
    adminPassword: 'synthetic-admin-password',
    ingestToken: 'synthetic-ingest-token-12345678',
    maintenanceMs: 30000,
  };
}
function store(c = config()) {
  const s = new Ledger(c);
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', content: text });
interface Options {
  thread?: string;
  session?: string;
  parent?: string;
  window?: string;
  previous?: string;
  responseId?: string;
  partial?: boolean;
  error?: boolean;
  userId?: number | null;
  tokenId?: number;
  format?: string;
  model?: string;
  charge?: number | null;
}
function envelope(input: unknown[], answer = 'answer', o: Options = {}): Envelope {
  const declaration = {
    thread_id: o.thread,
    session_id: o.session,
    parent_thread_id: o.parent,
    window_id: o.window,
    agent_name: 'worker',
    subagent_kind: 'explorer',
  };
  const body = {
    input,
    ...(o.previous ? { previous_response_id: o.previous } : {}),
    ...(o.thread
      ? { client_metadata: { 'x-codex-turn-metadata': JSON.stringify(declaration) } }
      : {}),
  };
  const output = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] },
  ];
  return {
    version: 1,
    upload_id: crypto.randomUUID(),
    source: 'synthetic',
    context: { format: o.format ?? 'openai_responses', model: o.model ?? 'test-model' },
    report: {
      requestId: crypto.randomUUID(),
      user: { id: o.userId === undefined ? 1 : o.userId },
      token: { id: o.tokenId ?? 1 },
      request: { body },
      response: {
        status: o.error ? 500 : 200,
        truncated: o.partial ?? false,
        ...(o.partial
          ? {
              events: [
                {
                  event: 'response.output_item.done',
                  data: { type: 'response.output_item.done', output_index: 0, item: output[0] },
                },
              ],
            }
          : { body: { id: o.responseId ?? crypto.randomUUID(), status: 'completed', output } }),
      },
      usage: { promptTokens: 3, completionTokens: 7 },
      cost: o.charge === null ? null : { quota: o.charge ?? 2 },
    },
  };
}
async function put(
  s: Ledger,
  input: unknown[],
  answer = 'answer',
  o: Options = {},
  receivedAt?: number,
) {
  const value = envelope(input, answer, o),
    bytes = Buffer.from(JSON.stringify(value));
  const result = await s.ingest(bytes, { receivedAt });
  expect(hash(s.restore(result.id))).toBe(hash(bytes));
  return row(s, result.id);
}
interface Row {
  id: number;
  parent_id: number | null;
  conversation_id: number | null;
  turn_index: number | null;
  link_rule: string | null;
  context_reset: string | null;
  thread_key: string | null;
  parent_coverage: number;
  evidence_chain: string | null;
  input_chain: string | null;
  announcements_valid: number;
  announced_output: string;
  completeness: string;
  retry_of: number | null;
  retry_of_turn: number | null;
  superseded: number;
  continuation_eligible: number;
  last_user_text: string;
  retry_input_chain: string;
}
function row(s: Ledger, id: number) {
  return s.db.query<Row, [number]>('SELECT * FROM requests WHERE id=?').get(id)!;
}
function conv(s: Ledger, id: number | null) {
  return s.db
    .query<Record<string, unknown>, [number | null]>('SELECT * FROM conversations WHERE id=?')
    .get(id)!;
}
function remove(s: Ledger, id: number) {
  (s as unknown as { deleteRoot(id: number): void }).deleteRoot(id);
}

test('exact prefix chains, same-input retries, edited branches, longest coverage and immutable own turn sequence', async () => {
  const s = store(),
    a = await put(s, [user('a')], 'A'),
    b = await put(s, [user('a'), assistant('A'), user('b')], 'B');
  const retry = await put(s, [user('a'), assistant('A'), user('b')], 'B2');
  const c = await put(s, [user('a'), assistant('A'), user('b'), assistant('B'), user('c')], 'C');
  expect(b.parent_id).toBe(a.id);
  expect(b.conversation_id).toBe(a.conversation_id);
  expect(b.turn_index).toBe(2);
  expect(retry.parent_id).toBe(a.id);
  expect(retry.conversation_id).toBe(a.conversation_id);
  expect(retry.turn_index).toBe(3);
  expect(retry.retry_of_turn).toBe(2);
  expect(row(s, b.id).superseded).toBe(1);
  const edited = await put(s, [user('a'), assistant('A'), user('edited')], 'edit');
  expect(edited.conversation_id).not.toBe(a.conversation_id);
  expect(conv(s, edited.conversation_id).forked_from_turn).toBe(1);
  expect(conv(s, edited.conversation_id).inherited_turns).toBe(1);
  expect(c.parent_id).toBe(b.id);
  expect(c.turn_index).toBe(4);
  expect(conv(s, a.conversation_id).own_turns).toBe(4);
  expect(conv(s, a.conversation_id).branch_count).toBe(1);
  remove(s, b.id);
  expect(row(s, c.id).turn_index).toBe(4);
  expect(row(s, c.id).parent_coverage).toBe(4);
  const d = await put(s, [
    user('a'),
    assistant('A'),
    user('b'),
    assistant('B'),
    user('c'),
    assistant('C'),
    user('d'),
  ]);
  expect(d.turn_index).toBe(5);
  expect(s.integrity().mismatches).toBe(0);
});
test('equal best coverage remains ambiguous and cannot fall back to a shorter ancestor', async () => {
  const s = store();
  await put(s, [user('a')], 'A');
  const input = [user('a'), assistant('A'), user('b')];
  await put(s, input, 'B');
  await put(s, input, 'B');
  const child = await put(s, [...input, assistant('B'), user('c')]);
  expect(child.parent_id).toBeNull();
  expect(child.turn_index).toBe(1);
});
test('partial output needs recovered evidence; errors and missing identities cannot parent', async () => {
  const s = store(),
    p = await put(s, [user('a')], 'A', { partial: true });
  const onlyInput = await put(s, [user('a'), user('b')]);
  expect(onlyInput.parent_id).toBeNull();
  const child = await put(s, [user('a'), assistant('A'), user('b')]);
  expect(child.parent_id).toBe(p.id);
  expect(child.link_rule).toBe('prefix_partial');
  const error = await put(s, [user('err')], 'ERR', { error: true });
  expect(error.evidence_chain).toBeNull();
  expect((await put(s, [user('err'), assistant('ERR'), user('next')])).parent_id).toBeNull();
  await put(s, [user('scope')], 'S', { userId: null });
  expect(
    (await put(s, [user('scope'), assistant('S'), user('next')], undefined, { userId: null }))
      .parent_id,
  ).toBeNull();
  expect(
    (await put(s, [user('a'), assistant('A'), user('isolated')], undefined, { tokenId: 2 }))
      .parent_id,
  ).toBeNull();
  const nonchat = await put(s, [user('x')], undefined, { format: 'openai_alpha_search' });
  expect(nonchat.conversation_id).toBeNull();
});
test('previous_response_id is exclusive, ambiguous ids fail closed, and mixed modes have no chain', async () => {
  const s = store(),
    p = await put(s, [user('a')], 'A', { responseId: 'response-a' });
  const miss = await put(s, [user('a'), assistant('A'), user('b')], 'B', { previous: 'missing' });
  expect(miss.parent_id).toBeNull();
  expect(miss.input_chain).toBeNull();
  expect(miss.evidence_chain).toBeNull();
  const child = await put(s, [user('incremental')], 'B', { previous: 'response-a' });
  expect(child.parent_id).toBe(p.id);
  expect(child.link_rule).toBe('prev_id');
  expect(child.parent_coverage).toBe(0);
  await put(s, [user('duplicate')], 'D', { responseId: 'response-a' });
  expect(
    (await put(s, [user('next')], undefined, { previous: 'response-a' })).parent_id,
  ).toBeNull();
});
test('declared threads retain primary resets and branch routing; explicit ids do not cross threads', async () => {
  const s = store(),
    opts = { thread: 'main', session: 'session', window: 'window1' };
  const a = await put(s, [user('a')], 'A', { ...opts, responseId: 'a' }),
    b = await put(s, [user('new context')], 'B', { ...opts, window: 'window2' });
  expect(a.context_reset).toBeNull();
  expect(b.conversation_id).toBe(a.conversation_id);
  expect(b.context_reset).toBe('window_changed');
  expect(b.turn_index).toBe(2);
  const c = await put(s, [user('newer context')], 'C', { ...opts, window: 'window2' });
  expect(c.context_reset).toBe('no_prefix');
  const continued = await put(s, [user('a'), assistant('A'), user('b')], 'B', opts);
  const fork = await put(s, [user('a'), assistant('A'), user('fork')], 'F', opts);
  expect(continued.conversation_id).toBe(a.conversation_id);
  expect(fork.conversation_id).not.toBe(a.conversation_id);
  expect(conv(s, fork.conversation_id).thread_key).toBe(a.thread_key);
  const forkNext = await put(
    s,
    [user('a'), assistant('A'), user('fork'), assistant('F'), user('next')],
    'NEXT',
    opts,
  );
  expect(forkNext.conversation_id).toBe(fork.conversation_id);
  expect(
    (
      await put(s, [user('different')], undefined, {
        thread: 'other',
        session: 'session',
        previous: 'a',
      })
    ).parent_id,
  ).toBeNull();
});
test('subagents link after parent arrival, count once, and reject conflicting/self/cyclic declarations', async () => {
  const s = store(),
    child = await put(s, [user('child')], 'A', { thread: 'child', session: 's', parent: 'main' });
  expect(
    s.db.query('SELECT subagent_of FROM threads WHERE thread_key=?').get(child.thread_key),
  ).toEqual({ subagent_of: null });
  const parent = await put(s, [user('main')], 'M', { thread: 'main', session: 's' });
  await put(s, [user('child again')], 'A', { thread: 'child', session: 's', parent: 'main' });
  expect(
    s.db.query('SELECT subagent_of FROM threads WHERE thread_key=?').get(child.thread_key),
  ).toEqual({ subagent_of: parent.conversation_id });
  expect(
    s.db.query('SELECT subagent_count FROM threads WHERE thread_key=?').get(parent.thread_key),
  ).toEqual({ subagent_count: 1 });
  await put(s, [user('conflict')], 'C', { thread: 'child', session: 'different', parent: 'main' });
  expect(
    s.db.query('SELECT conflict,subagent_of FROM threads WHERE thread_key=?').get(child.thread_key),
  ).toEqual({ conflict: 1, subagent_of: null });
  expect(
    s.db.query('SELECT subagent_count FROM threads WHERE thread_key=?').get(parent.thread_key),
  ).toEqual({ subagent_count: 0 });
  const self = await put(s, [user('self')], 'S', { thread: 'self', session: 's', parent: 'self' });
  expect(
    s.db.query('SELECT subagent_of FROM threads WHERE thread_key=?').get(self.thread_key),
  ).toEqual({ subagent_of: null });
  const a = await put(s, [user('cycle')], 'A', {
    thread: 'cycle-a',
    session: 's',
    parent: 'cycle-b',
  });
  const b = await put(s, [user('cycle')], 'B', {
    thread: 'cycle-b',
    session: 's',
    parent: 'cycle-a',
  });
  for (const r of [a, b])
    expect(
      s.db.query('SELECT subagent_of FROM threads WHERE thread_key=?').get(r.thread_key),
    ).toEqual({ subagent_of: null });
  remove(s, a.id);
  remove(s, b.id);
  expect(
    s.db
      .query('SELECT count(*) AS n FROM threads WHERE thread_key IN (?,?)')
      .get(a.thread_key, b.thread_key),
  ).toEqual({ n: 0 });
  const isolated = await put(s, [user('isolation')], 'I', {
    thread: 'main',
    session: 's',
    tokenId: 2,
  });
  expect(isolated.thread_key).not.toBe(parent.thread_key);
});
test('retention preserves primary tombstone numbering, declared origins and incremental aggregates', async () => {
  const s = store(),
    o = { thread: 'main', session: 's' };
  const a = await put(s, [user('a')], 'A', o, 10);
  const b = await put(s, [user('a'), assistant('A'), user('b')], 'B', o, 20);
  const branch = await put(
    s,
    [user('a'), assistant('A'), user('branch')],
    'F',
    { ...o, charge: null },
    30,
  );
  remove(s, a.id);
  remove(s, b.id);
  expect(conv(s, a.conversation_id)).toBeNull();
  expect(conv(s, branch.conversation_id).forked_from_conversation).toBe(a.conversation_id);
  const reset = await put(s, [user('new')], 'N', o, 40);
  expect(reset.conversation_id).toBe(a.conversation_id);
  expect(reset.turn_index).toBe(3);
  expect(reset.context_reset).toBe('no_prefix');
  expect(conv(s, reset.conversation_id).own_turns).toBe(1);
  expect(conv(s, reset.conversation_id).input_tokens).toBe(3);
  expect(conv(s, branch.conversation_id).charge_quota).toBeNull();
  remove(s, branch.id);
  expect(conv(s, reset.conversation_id).branch_count).toBe(0);
  remove(s, reset.id);
  expect(s.db.query('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 0 });
  expect(s.db.query('SELECT count(*) AS n FROM conversation_models').get()).toEqual({ n: 0 });
});
function downgrade(s: Ledger) {
  s.db.exec('DROP INDEX requests_search_output');
  s.db.exec(
    'DROP TABLE conversation_models; DROP TABLE threads; DROP TABLE conversations; DROP INDEX requests_evidence; DROP INDEX requests_response; DROP INDEX requests_thread; DROP INDEX requests_session; DROP INDEX requests_parent_thread; DROP INDEX requests_conversation; DROP INDEX requests_parent; DROP INDEX requests_conversation_time; DROP INDEX requests_retry; DROP INDEX requests_parent_eligible; DROP INDEX requests_partial_input;',
  );
  for (const col of Object.keys(requestIndexColumns))
    s.db.exec(`ALTER TABLE requests DROP COLUMN ${col}`);
  s.db.exec('PRAGMA user_version=2');
}
test('v2 restart backfill verifies evidence, preserves bytes and refs, and publishes atomically', async () => {
  const c = config(),
    s = store(c);
  const a = await put(s, [user('a')], 'A');
  const b = await put(s, [user('a'), assistant('A'), user('b')]);
  const bytes = s.restore(a.id);
  downgrade(s);
  s.close();
  stores.splice(stores.indexOf(s), 1);
  const restarted = store(c);
  expect(row(restarted, b.id).parent_id).toBe(a.id);
  expect(restarted.restore(a.id)).toEqual(bytes);
  expect(restarted.integrity().mismatches).toBe(0);
  expect(restarted.db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
  downgrade(restarted);
  restarted.db.query('UPDATE requests SET body_hash=? WHERE id=?').run('0'.repeat(64), a.id);
  restarted.close();
  stores.splice(stores.indexOf(restarted), 1);
  expect(() => new Ledger(c)).toThrow();
  const db = new Database(c.database);
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='conversations'").get()).toBeNull();
  db.close();
});

test('longer partial evidence outranks complete ancestor and disappearing parents fail closed', async () => {
  const s = store();
  const first = await put(s, [user('a')], 'A');
  const middleInput = [user('a'), assistant('A'), user('b')];
  const partial = await put(s, middleInput, 'B', { partial: true });
  const next = await put(s, [...middleInput, assistant('B'), user('c')]);
  expect(next.parent_id).toBe(partial.id);
  expect(next.link_rule).toBe('prefix_partial');
  const original = s.conversations.prepare.bind(s.conversations);
  s.conversations.prepare = (normalized, meta) => {
    expect(s.db.inTransaction).toBe(false);
    const prepared = original(normalized, meta);
    if (prepared.parent) remove(s, prepared.parent.id);
    return prepared;
  };
  const afterRemoval = await put(s, [user('a'), assistant('A'), user('new')]);
  expect(afterRemoval.parent_id).toBeNull();
  expect(afterRemoval.conversation_id).not.toBe(first.conversation_id);
  expect(afterRemoval.turn_index).toBe(1);
});

test('retained declared child preserves missing-parent tombstone and bounded cleanup releases both', async () => {
  const s = store();
  const parent = await put(s, [user('main')], 'M', { thread: 'main', session: 's' });
  const child = await put(s, [user('child')], 'C', {
    thread: 'child',
    session: 's',
    parent: 'main',
  });
  remove(s, parent.id);
  expect(conv(s, parent.conversation_id)).toBeNull();
  expect(
    s.db.query('SELECT subagent_of FROM threads WHERE thread_key=?').get(child.thread_key),
  ).toEqual({ subagent_of: parent.conversation_id });
  expect(s.db.query('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 2 });
  remove(s, child.id);
  expect(s.db.query('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 0 });
});

test('consecutive 502-shaped siblings then success remain one conversation with superseded attempts', async () => {
  const s = store();
  const p = await put(s, [user('main')], 'P', { thread: 'main', session: 's' });
  const input = [user('main'), assistant('P'), user('same task')],
    failed: Row[] = [];
  for (let i = 0; i < 7; i++)
    failed.push(await put(s, input, '', { thread: 'main', session: 's', error: true }));
  const success = await put(s, input, 'OK', { thread: 'main', session: 's' });
  expect(success.conversation_id).toBe(p.conversation_id);
  expect(success.turn_index).toBe(9);
  expect(success.retry_of_turn).toBe(8);
  for (const attempt of failed) {
    expect(attempt.conversation_id).toBe(p.conversation_id);
    expect(row(s, attempt.id).superseded).toBe(1);
    expect(attempt.continuation_eligible).toBe(0);
  }
  expect(conv(s, p.conversation_id).branch_count).toBe(0);
  expect(conv(s, p.conversation_id).has_error).toBe(0);
  expect(conv(s, p.conversation_id).error_turns).toBe(7);
  expect(conv(s, p.conversation_id).charge_quota).toBe(18);
  remove(s, success.id);
  expect(conv(s, p.conversation_id).has_error).toBe(1);
  expect(row(s, failed.at(-1)!.id).superseded).toBe(0);
});
test('no-evidence partial attempts leave the continuation slot free and retry flags track the last own turn', async () => {
  const s = store(),
    p = await put(s, [user('p')], 'P');
  const input = [user('p'), assistant('P'), user('next')];
  const partial = await put(s, input, '', { partial: true });
  expect(partial.evidence_chain).toBeNull();
  expect(partial.continuation_eligible).toBe(0);
  expect(conv(s, p.conversation_id).has_partial).toBe(1);
  const retry = await put(s, input, 'done');
  expect(retry.retry_of_turn).toBe(partial.turn_index);
  expect(retry.conversation_id).toBe(p.conversation_id);
  expect(conv(s, p.conversation_id).has_partial).toBe(0);
  const edited = await put(s, [user('p'), assistant('P'), user('edit')], 'edited');
  expect(edited.conversation_id).not.toBe(p.conversation_id);
  const noEvidence = await put(s, [user('root')], '', { partial: true });
  const different = await put(s, [user('root'), user('still unanchored')], 'done');
  expect(different.conversation_id).not.toBe(noEvidence.conversation_id);
});
test('retry anchors isolate undeclared roots, scopes, threads, and previous-response modes', async () => {
  const s = store();
  const a = await put(s, [user('common')], '', { error: true });
  const b = await put(s, [user('common')], 'done');
  expect(b.conversation_id).not.toBe(a.conversation_id);
  expect(b.retry_of_turn).toBeNull();
  const declared = await put(s, [user('common')], '', { thread: 't', error: true });
  const retry = await put(s, [user('common')], 'done', { thread: 't' });
  expect(retry.conversation_id).toBe(declared.conversation_id);
  expect(retry.retry_of_turn).toBe(1);
  expect(retry.context_reset).toBeNull();
  const otherThread = await put(s, [user('common')], 'done', { thread: 'other' });
  const otherToken = await put(s, [user('common')], 'done', { thread: 't', tokenId: 2 });
  expect(otherThread.retry_of_turn).toBeNull();
  expect(otherToken.retry_of_turn).toBeNull();
  const parent = await put(s, [user('p')], 'P', { responseId: 'parent' });
  const previous = await put(s, [user('incremental')], '', { previous: 'parent', error: true });
  const previousRetry = await put(s, [user('incremental')], 'done', { previous: 'parent' });
  expect(previousRetry.conversation_id).toBe(parent.conversation_id);
  expect(previousRetry.retry_of_turn).toBe(previous.turn_index);
  expect(previousRetry.input_chain).toBeNull();
  expect(previousRetry.evidence_chain).toBeNull();
  expect(previousRetry.continuation_eligible).toBe(1);
  const edit = await put(s, [user('incremental edit')], 'done', { previous: 'parent' });
  expect(edit.conversation_id).not.toBe(parent.conversation_id);
  const missed = await put(s, [user('same')], '', { previous: 'unknown-a', error: true });
  const missedRetry = await put(s, [user('same')], 'done', { previous: 'unknown-a' });
  const differentId = await put(s, [user('same')], 'done', { previous: 'unknown-b' });
  expect(missedRetry.conversation_id).toBe(missed.conversation_id);
  expect(differentId.conversation_id).not.toBe(missed.conversation_id);
});
test('real-user title fallback, one-time fill and latest-state retention use bounded projections', async () => {
  const s = store();
  const parent = await put(s, [user('real first')], 'A');
  const child = await put(
    s,
    [
      user('real first'),
      assistant('A'),
      { type: 'function_call_output', call_id: 'call', output: 'result' },
    ],
    'B',
  );
  // A content fork with no new user text falls back to the full-input real user summary.
  const fork = await put(
    s,
    [
      user('real first'),
      assistant('A'),
      { type: 'function_call_output', call_id: 'call', output: 'different' },
    ],
    'C',
  );
  expect(fork.conversation_id).not.toBe(parent.conversation_id);
  expect(conv(s, fork.conversation_id).title).toBe('real first');
  expect(fork.last_user_text).toBe('real first');
  const empty = await put(
    s,
    [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://invalid.test/image' }] }],
    '',
    { thread: 'empty', error: true },
  );
  expect(conv(s, empty.conversation_id).title).toBe('');
  expect(empty.last_user_text).toBe('');
  const fill = await put(s, [user('first real title')], 'done', { thread: 'empty' });
  expect(conv(s, fill.conversation_id).title).toBe('first real title');
  const latest = await put(s, [user('later different title')], '', {
    thread: 'empty',
    partial: true,
  });
  expect(conv(s, latest.conversation_id).title).toBe('first real title');
  expect(conv(s, latest.conversation_id).has_partial).toBe(1);
  expect(conv(s, latest.conversation_id).has_error).toBe(0);
  remove(s, latest.id);
  expect(conv(s, fill.conversation_id).has_partial).toBe(0);
  remove(s, fill.id);
  expect(conv(s, empty.conversation_id).has_error).toBe(1);
  expect(conv(s, empty.conversation_id).title).toBe('first real title');
  expect(child.last_user_text).toBe('real first');
});

const schema4Only = [
  'retry_input_chain',
  'previous_response_id',
  'retry_of',
  'retry_of_turn',
  'superseded',
  'continuation_eligible',
  'last_user_text',
];
function downgradeV4(s: Ledger) {
  s.db.exec(
    'DROP INDEX requests_partial_input; ALTER TABLE requests DROP COLUMN announced_output; ALTER TABLE requests DROP COLUMN announcements_valid; PRAGMA user_version=4;',
  );
}
function downgradeV3(s: Ledger) {
  downgradeV4(s);
  s.db.exec('DROP INDEX requests_retry; DROP INDEX requests_parent_eligible;');
  for (const column of schema4Only) s.db.exec(`ALTER TABLE requests DROP COLUMN ${column}`);
  s.db.exec('PRAGMA user_version=3');
}
for (const oldVersion of [3, 4] as const)
  test(`v${oldVersion} rebuild and explicit rebuild preserve immutable roots, CAS, usage, charges, uploads and pins`, async () => {
    const c = config(),
      s = store(c);
    const input = [user(`large root ${'x'.repeat(2500)}`)];
    const p = await put(s, input, 'P', { thread: 'main' });
    const retryInput = [...input, assistant('P'), user('next')];
    const failed = await put(s, retryInput, '', { thread: 'main', error: true });
    const success = await put(s, retryInput, 'OK', { thread: 'main' });
    const objects = s.db.query('SELECT * FROM objects ORDER BY hash').all();
    expect(objects.length).toBeGreaterThan(0);
    const firstObject = s.db
      .query<{ hash: string; length: number }, []>('SELECT hash,length FROM objects LIMIT 1')
      .get()!;
    s.db
      .query(
        'INSERT INTO uploads(upload_id,source,manifest_hash,manifest,envelope_hash,envelope_bytes,state,created_at,expires_at,updated_at,hint) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'pending-synthetic',
        'synthetic',
        'm',
        '{}',
        'e',
        firstObject.length,
        'partial',
        1,
        Date.now() + 60_000,
        1,
        '{}',
      );
    s.db
      .query('INSERT INTO pending_pins(upload_id,hash,length,idx,priority) VALUES(?,?,?,?,?)')
      .run('pending-synthetic', firstObject.hash, firstObject.length, 0, 0);
    const immutableSQL =
      'SELECT id,received_at,source,upload_id,host_request_id,model,channel,user_label,token_label,outcome,truncated,media,duration_ms,usage_json,cost_json,body_hash,body_length,wire_manifest_hash,storage_mode,payload FROM requests ORDER BY id';
    const original = s.db.query(immutableSQL).all(),
      uploads = s.db.query('SELECT * FROM uploads').all(),
      pins = s.db.query('SELECT * FROM pending_pins').all();
    const expectedBytes = s.restore(p.id);
    if (oldVersion === 3) downgradeV3(s);
    else downgradeV4(s);
    s.db
      .query('UPDATE requests SET conversation_id=999,turn_index=99,parent_id=NULL WHERE id=?')
      .run(success.id);
    s.close();
    stores.splice(stores.indexOf(s), 1);
    const reopened = store(c);
    expect(reopened.db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(row(reopened, success.id).conversation_id).toBe(row(reopened, p.id).conversation_id);
    expect(row(reopened, success.id).retry_of).toBe(failed.id);
    expect(reopened.db.query(immutableSQL).all()).toEqual(original);
    expect(reopened.db.query('SELECT * FROM objects ORDER BY hash').all()).toEqual(objects);
    expect(reopened.db.query('SELECT * FROM uploads').all()).toEqual(uploads);
    expect(reopened.db.query('SELECT * FROM pending_pins').all()).toEqual(pins);
    expect(reopened.restore(p.id)).toEqual(expectedBytes);
    reopened.rebuildConversations();
    expect(reopened.db.query(immutableSQL).all()).toEqual(original);
    expect(reopened.integrity().mismatches).toBe(0);
  });
test('backfill command backs up schema4 before opening and explicitly rebuilds the current schema', async () => {
  const c = config(),
    s = store(c);
  const record = await put(s, [user('backup me')], 'OK', { thread: 'main' });
  const bytes = s.restore(record.id);
  downgradeV4(s);
  s.close();
  stores.splice(stores.indexOf(s), 1);
  const destination = join(c.database, '..', 'before-v6.sqlite');
  const env = {
    ...process.env,
    LEDGER_DATABASE: c.database,
    LEDGER_MAX_STORAGE_MB: '32',
    LEDGER_SOURCE: c.source,
    LEDGER_ADMIN_PASSWORD: c.adminPassword,
    LEDGER_INGEST_TOKEN: c.ingestToken,
    LEDGER_RESERVE_BYTES: String(c.reserveBytes),
  };
  const refused = spawnSync(
    process.execPath,
    ['scripts/backfill-conversations.ts', '--backup', c.database, '--rebuild'],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('Backup destination exists');
  const unchanged = new Database(c.database, { readonly: true });
  expect(unchanged.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
  expect(unchanged.query('SELECT body_hash FROM requests WHERE id=?').get(record.id)).toEqual({
    body_hash: hash(bytes),
  });
  unchanged.close();
  const result = spawnSync(
    process.execPath,
    ['scripts/backfill-conversations.ts', '--backup', destination, '--rebuild'],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).schema).toBe(7);
  const before = new Database(destination, { readonly: true });
  expect(before.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
  expect(before.query('SELECT body_hash FROM requests WHERE id=?').get(record.id)).toEqual({
    body_hash: hash(bytes),
  });
  before.close();
  const reopened = store(c);
  expect(reopened.restore(record.id)).toEqual(bytes);
  expect(reopened.db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
});

function downgradeV5(s: Ledger) {
  downgradeV6(s);
  s.db.exec('DROP INDEX conversations_cost');
  for (const key of statisticColumns) {
    s.db.exec(`ALTER TABLE requests DROP COLUMN ${key}`);
    for (const column of [key, `known_${key}`, `unknown_${key}`])
      s.db.exec(`ALTER TABLE conversations DROP COLUMN ${column}`);
  }
  s.db.exec('PRAGMA user_version=5');
}

function downgradeV6(s: Ledger) {
  s.db.exec('DROP INDEX requests_search_output');
  for (const table of [
    'tool_call_origins',
    'tool_output_candidates',
    'tool_output_parts',
    'search_links',
  ])
    s.db.exec(`DROP TABLE ${table}`);
  for (const column of [
    'incomplete_reason',
    'search_session_key',
    'search_output_hash',
    'search_summary',
  ])
    s.db.exec(`ALTER TABLE requests DROP COLUMN ${column}`);
  for (const column of [
    'search_count',
    'search_known_charge',
    'search_unknown_charge',
    'search_known_charge_usd',
    'search_unknown_charge_usd',
  ])
    s.db.exec(`ALTER TABLE conversations DROP COLUMN ${column}`);
  s.db.exec('PRAGMA user_version=6');
}

for (const version of [5, 6]) {
  test(`schema${version} projects searches atomically without changing membership, evidence, CAS or receipts`, async () => {
    const c = config();
    const s = store(c);
    const input = [user(`migration ${'x'.repeat(2500)}`)];
    const call = {
      type: 'function_call',
      name: 'web.run',
      call_id: 'migration-call',
      arguments: '{}',
    };
    const initial = envelope(input, '', { thread: 'migration', session: 'migration-session' });
    initial.report.response = {
      status: 200,
      body: { id: 'migration-parent', status: 'completed', output: [call] },
    };
    initial.report.cost = { quota: 2, usd: 0.002 };
    const first = await s.ingest(Buffer.from(JSON.stringify(initial)));
    const consumer = envelope(
      [
        ...input,
        call,
        { type: 'function_call_output', call_id: call.call_id, output: 'migration search output' },
      ],
      'done',
      { thread: 'migration', session: 'migration-session' },
    );
    consumer.report.cost = { quota: 3, usd: 0.003 };
    const consumed = await s.ingest(Buffer.from(JSON.stringify(consumer)));
    const search = envelope([], '', { format: 'openai_alpha_search' });
    search.report.request = {
      body: { id: 'migration-session', commands: { search_query: [{ q: 'migration' }] } },
    };
    search.report.response = {
      status: 200,
      stream: false,
      body: { output: 'migration search output', results: [{ title: 'source' }] },
    };
    search.report.cost = { quota: 5000, usd: 0.01 };
    const searched = await s.ingest(Buffer.from(JSON.stringify(search)));
    const cid = row(s, consumed.id).conversation_id;
    expect(conv(s, cid)).toMatchObject({
      own_turns: 2,
      search_count: 1,
      charge_quota: 5005,
      charge_usd: 0.015,
    });
    const partial = await put(s, [user('truncated')], '', { partial: true });
    const noTerminal = envelope([user('missing terminal')]);
    noTerminal.report.response = { status: 200, events: [] };
    const interrupted = await s.ingest(Buffer.from(JSON.stringify(noTerminal)));
    const explicitIncomplete = envelope([user('explicit model stop')]);
    explicitIncomplete.report.response = {
      status: 200,
      body: {
        id: 'explicit-incomplete',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
      },
    };
    const incomplete = await s.ingest(Buffer.from(JSON.stringify(explicitIncomplete)));
    // Old adapters considered this terminal a complete capture and missed the stop reason.
    s.db
      .query("UPDATE requests SET completeness='complete',stop_reason=NULL WHERE id=?")
      .run(incomplete.id);
    s.db
      .query('UPDATE conversations SET has_partial=0,partial_turns=0 WHERE id=?')
      .run(row(s, incomplete.id).conversation_id);
    const bodies = s.db
      .query<{ id: number }, []>('SELECT id FROM requests ORDER BY id')
      .all()
      .map(({ id }) => ({ id, bytes: s.restore(id) }));
    if (version === 5) downgradeV5(s);
    else downgradeV6(s);
    s.db.query("UPDATE requests SET completeness='partial' WHERE id=?").run(searched.id);
    const membership = s.db
      .query(
        'SELECT id,conversation_id,turn_index,parent_id,parent_coverage,link_rule,retry_of,superseded FROM requests ORDER BY id',
      )
      .all();
    const statuses = s.db
      .query('SELECT id,completeness FROM requests WHERE conversation_id IS NOT NULL ORDER BY id')
      .all();
    const flags = s.db
      .query(
        'SELECT id,has_error,has_partial,error_turns,partial_turns FROM conversations ORDER BY id',
      )
      .all();
    const threads = s.db.query('SELECT * FROM threads ORDER BY thread_key').all();
    const objects = s.db.query('SELECT * FROM objects ORDER BY hash').all();
    const immutable =
      'SELECT id,upload_id,body_hash,body_length,usage_json,cost_json,wire_manifest_hash,payload FROM requests ORDER BY id';
    const roots = s.db.query(immutable).all();
    const receipts = s.db.query('SELECT * FROM uploads').all();
    const pins = s.db.query('SELECT * FROM pending_pins').all();
    s.close();
    stores.splice(stores.indexOf(s), 1);
    const reopened = store(c);
    expect(reopened.db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(
      reopened.db
        .query(
          'SELECT id,conversation_id,turn_index,parent_id,parent_coverage,link_rule,retry_of,superseded FROM requests ORDER BY id',
        )
        .all(),
    ).toEqual(membership);
    expect(reopened.db.query('SELECT * FROM threads ORDER BY thread_key').all()).toEqual(threads);
    expect(
      reopened.db
        .query('SELECT id,completeness FROM requests WHERE conversation_id IS NOT NULL ORDER BY id')
        .all(),
    ).toEqual(statuses);
    expect(
      reopened.db
        .query(
          'SELECT id,has_error,has_partial,error_turns,partial_turns FROM conversations ORDER BY id',
        )
        .all(),
    ).toEqual(flags);
    expect(
      reopened.db
        .query('SELECT completeness,stop_reason FROM requests WHERE id=?')
        .get(incomplete.id),
    ).toEqual({ completeness: 'complete', stop_reason: 'max_output_tokens' });
    expect(reopened.db.query('SELECT * FROM objects ORDER BY hash').all()).toEqual(objects);
    expect(reopened.db.query(immutable).all()).toEqual(roots);
    expect(reopened.db.query('SELECT * FROM uploads').all()).toEqual(receipts);
    expect(reopened.db.query('SELECT * FROM pending_pins').all()).toEqual(pins);
    for (const body of bodies) expect(reopened.restore(body.id)).toEqual(body.bytes);
    expect(row(reopened, searched.id)).toMatchObject({
      completeness: 'complete',
      conversation_id: null,
    });
    expect(
      reopened.db.query('SELECT incomplete_reason FROM requests WHERE id=?').get(partial.id),
    ).toEqual({ incomplete_reason: 'truncated' });
    expect(
      reopened.db.query('SELECT incomplete_reason FROM requests WHERE id=?').get(interrupted.id),
    ).toEqual({ incomplete_reason: 'no_terminal' });
    expect(conv(reopened, cid)).toMatchObject({
      own_turns: 2,
      next_turn: 3,
      search_count: 1,
      charge_quota: 5005,
      charge_usd: 0.015,
    });
    expect(reopened.db.query('SELECT * FROM search_links').get()).toMatchObject({
      search_record_id: searched.id,
      consumer_record_id: consumed.id,
      item_index: 2,
      part_index: 0,
      call_id: call.call_id,
    });
    expect(reopened.integrity().mismatches).toBe(0);
    const plan = reopened.db
      .query(
        'EXPLAIN QUERY PLAN SELECT id FROM requests WHERE search_session_key=? AND search_output_hash=? LIMIT 2',
      )
      .all('session', 'hash');
    expect(JSON.stringify(plan)).toContain('requests_search_output');
    reopened.db.transaction(() => remove(reopened, searched.id)).immediate();
    expect(conv(reopened, cid)).toMatchObject({
      own_turns: 2,
      search_count: 0,
      charge_quota: 5,
      charge_usd: 0.005,
    });
    expect(row(reopened, first.id).turn_index).toBe(1);
  });
}

test('schema5 migration backfills projected statistics from evidence with retained turn IDs', async () => {
  const c = config();
  const s = store(c);
  const input = [user(`first ${'x'.repeat(2500)}`)];
  const a = await put(s, input, 'A', { thread: 'main' });
  const env = envelope([...input, assistant('A'), user('second')], 'B', { thread: 'main' });
  env.report.usage = {
    promptTokens: 45,
    cacheTokens: 18,
    cacheWriteTokens: 7,
    inputTokensTotal: 60,
  };
  env.report.cost = { quota: 50000, usd: 0.1 };
  const bytes = Buffer.from(JSON.stringify(env));
  const retained = await s.ingest(bytes);
  s.db.transaction(() => remove(s, a.id)).immediate();
  const omittedWrites = envelope([user('no writes')], 'C');
  omittedWrites.report.usage = { promptTokens: 45, cacheTokens: 18 };
  const zero = await s.ingest(Buffer.from(JSON.stringify(omittedWrites)));
  const zeroConversation = row(s, zero.id).conversation_id;
  downgradeV5(s);
  s.db
    .query('UPDATE requests SET usage_json=? WHERE id=?')
    .run('{"promptTokens":45,"cacheTokens":18}', retained.id);
  const roots = s.db.query('SELECT * FROM requests').all();
  const threads = s.db.query('SELECT * FROM threads').all();
  const objects = s.db.query('SELECT * FROM objects ORDER BY hash').all();
  const before = conv(s, a.conversation_id);
  expect(before).toMatchObject({ own_turns: 1, next_turn: 3, charge_quota: 50000 });
  s.close();
  stores.splice(stores.indexOf(s), 1);

  const reopened = store(c);
  expect(reopened.db.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
  const backupDirectory = join(dirname(c.database), 'backups');
  const backupNames = readdirSync(backupDirectory);
  expect(backupNames).toHaveLength(1);
  const backupPath = join(backupDirectory, backupNames[0]!);
  expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  const backup = new Database(backupPath, { readonly: true });
  try {
    expect(backup.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(backup.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(backup.query('SELECT * FROM requests').all()).toEqual(roots);
    expect(backup.query('SELECT * FROM threads').all()).toEqual(threads);
    expect(backup.query('SELECT * FROM objects ORDER BY hash').all()).toEqual(objects);
    expect(backup.query('SELECT * FROM conversations WHERE id=?').get(a.conversation_id)).toEqual(
      before,
    );
  } finally {
    backup.close();
  }
  expect(
    reopened.db.query(`SELECT ${Object.keys(roots[0] as object).join(',')} FROM requests`).all(),
  ).toEqual(roots);
  expect(reopened.db.query('SELECT * FROM threads').all()).toEqual(threads);
  expect(reopened.db.query('SELECT * FROM objects ORDER BY hash').all()).toEqual(objects);
  expect(reopened.restore(retained.id)).toEqual(bytes);
  expect(row(reopened, retained.id)).toMatchObject({
    conversation_id: a.conversation_id,
    turn_index: 2,
    cache_read_tokens: 18,
    cache_write_tokens: 7,
    input_total_tokens: 60,
    charge_usd: 0.1,
  });
  expect(conv(reopened, a.conversation_id)).toMatchObject({
    ...before,
    cache_read_tokens: 18,
    cache_write_tokens: 7,
    input_total_tokens: 60,
    charge_usd: 0.1,
  });
  expect(row(reopened, zero.id)).toMatchObject({ cache_read_tokens: 18, cache_write_tokens: 0 });
  expect(conv(reopened, zeroConversation)).toMatchObject({
    cache_read_tokens: 18,
    cache_write_tokens: 0,
  });
  expect(reopened.integrity().mismatches).toBe(0);
  const future = await put(reopened, [user('unmatched new window')], 'C', { thread: 'main' });
  expect(future).toMatchObject({ conversation_id: a.conversation_id, turn_index: 3 });
  reopened.rebuildConversations();
  const rebuilt = row(reopened, zero.id);
  expect(rebuilt).toMatchObject({ cache_read_tokens: 18, cache_write_tokens: 0 });
  expect(conv(reopened, rebuilt.conversation_id)).toMatchObject({ cache_write_tokens: 0 });
});

test('schema5 publication failure rolls back columns, search projections, statistics and schema version', async () => {
  const c = config();
  const s = store(c);
  await put(s, [user('publish first')]);
  const last = await put(s, [user('publish last')]);
  downgradeV5(s);
  s.db.exec(`CREATE TRIGGER reject_projection BEFORE UPDATE ON requests WHEN NEW.id=${last.id}
    BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END`);
  const roots = s.db.query('SELECT * FROM requests ORDER BY id').all();
  const conversations = s.db.query('SELECT * FROM conversations ORDER BY id').all();
  const schema = s.db.query('SELECT * FROM sqlite_master ORDER BY name').all();
  s.close();
  stores.splice(stores.indexOf(s), 1);
  expect(() => new Ledger(c)).toThrow('synthetic publication failure');
  const db = new Database(c.database, { readonly: true });
  try {
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(db.query('SELECT * FROM requests ORDER BY id').all()).toEqual(roots);
    expect(db.query('SELECT * FROM conversations ORDER BY id').all()).toEqual(conversations);
    expect(db.query('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  } finally {
    db.close();
  }
});

for (const version of [5, 6])
  test(`schema${version} migration leaves projections and version untouched when evidence fails verification`, async () => {
    const c = config();
    const s = store(c);
    await put(s, [user('first')]);
    const last = await put(s, [user('second')]);
    if (version === 5) downgradeV5(s);
    else downgradeV6(s);
    s.db.query('UPDATE requests SET body_hash=? WHERE id=?').run('0'.repeat(64), last.id);
    const before = s.db.query('SELECT * FROM conversations ORDER BY id').all();
    const roots = s.db.query('SELECT * FROM requests ORDER BY id').all();
    s.close();
    stores.splice(stores.indexOf(s), 1);

    expect(() => new Ledger(c)).toThrow();
    const db = new Database(c.database, { readonly: true });
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: version });
      expect(db.query('SELECT * FROM conversations ORDER BY id').all()).toEqual(before);
      expect(db.query('SELECT * FROM requests ORDER BY id').all()).toEqual(roots);
      expect(
        db
          .query("SELECT 1 FROM pragma_table_info('requests') WHERE name='incomplete_reason'")
          .get(),
      ).toBeNull();
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name='search_links'").get()).toBeNull();
    } finally {
      db.close();
    }
  });

test('incremental previous-response input titles use the first new real user text', async () => {
  const s = store();
  await put(s, [user('original')], 'P', { responseId: 'p' });
  await put(s, [user('first continuation')], 'done', { previous: 'p' });
  const edited = await put(s, [user('FIRST new text'), user('SECOND new text')], 'done', {
    previous: 'p',
  });
  expect(conv(s, edited.conversation_id).title).toBe('FIRST new text');
  expect(edited.last_user_text).toBe('SECOND new text');
  const missing = await put(
    s,
    [user('FIRST unobserved-anchor'), user('SECOND unobserved-anchor')],
    'done',
    { previous: 'missing' },
  );
  expect(conv(s, missing.conversation_id).title).toBe('FIRST unobserved-anchor');
});

test('retention restores supersession only within the same declared or undeclared thread scope', async () => {
  const s = store();
  const parent = await put(s, [user('root')], 'ROOT', { thread: 'main' });
  const input = [user('root'), assistant('ROOT'), user('same child')];
  const declaredFailure = await put(s, input, '', { thread: 'main', error: true });
  const undeclaredFailure = await put(s, input, '', { error: true });
  const declaredSuccess = await put(s, input, 'declared success', { thread: 'main' });
  const undeclaredSuccess = await put(s, input, 'undeclared success');
  for (const item of [declaredFailure, undeclaredFailure, declaredSuccess, undeclaredSuccess])
    expect(item.conversation_id).toBe(parent.conversation_id);
  expect(declaredSuccess.retry_of).toBe(declaredFailure.id);
  expect(undeclaredSuccess.retry_of).toBe(undeclaredFailure.id);
  expect(row(s, declaredFailure.id).superseded).toBe(1);
  expect(row(s, undeclaredFailure.id).superseded).toBe(1);
  remove(s, undeclaredSuccess.id);
  expect(row(s, undeclaredFailure.id).superseded).toBe(0);
  expect(row(s, declaredFailure.id).superseded).toBe(1);
  expect(row(s, declaredSuccess.id).superseded).toBe(0);
  remove(s, declaredSuccess.id);
  expect(row(s, declaredFailure.id).superseded).toBe(0);
  expect(conv(s, parent.conversation_id).has_error).toBe(1);
});

test('previous-response slot occupancy uses recovered completed output without becoming prefix evidence', async () => {
  const s = store();
  const parent = await put(s, [user('root')], 'ROOT', { responseId: 'parent' });
  const partial = await put(s, [user('incremental')], 'recovered', {
    previous: 'parent',
    partial: true,
  });
  expect(partial.continuation_eligible).toBe(1);
  expect(partial.evidence_chain).toBeNull();
  expect(partial.input_chain).toBeNull();
  const edited = await put(s, [user('edited incremental')], 'done', { previous: 'parent' });
  expect(edited.conversation_id).not.toBe(parent.conversation_id);
  expect(conv(s, edited.conversation_id).forked_from_conversation).toBe(parent.conversation_id);
  const prefix = await put(s, [user('incremental'), assistant('recovered'), user('next')], 'done');
  expect(prefix.parent_id).toBeNull();
  const other = await put(s, [user('other root')], 'OTHER', { responseId: 'other-parent' });
  const emptyPartial = await put(s, [user('empty incremental')], '', {
    previous: 'other-parent',
    partial: true,
  });
  expect(emptyPartial.continuation_eligible).toBe(0);
  const continuation = await put(s, [user('different incremental')], 'done', {
    previous: 'other-parent',
  });
  expect(continuation.conversation_id).toBe(other.conversation_id);
  expect(continuation.retry_of).toBeNull();
  expect(conv(s, other.conversation_id).branch_count).toBe(0);
});

const reasoningItem = (id: string) => ({ type: 'reasoning', id, status: 'completed', summary: [] });
const callItem = (id: string, args = '{}') => ({
  type: 'function_call',
  id,
  call_id: `call-${id}`,
  name: 'tool',
  arguments: args,
  status: 'completed',
});
const toolResult = (id: string) => ({
  type: 'function_call_output',
  call_id: `call-${id}`,
  output: 'result',
});
const itemAdded = (index: number, item: unknown) => ({
  event: 'response.output_item.added',
  data: { type: 'response.output_item.added', output_index: index, item },
});
const itemDone = (index: number, item: unknown) => ({
  event: 'response.output_item.done',
  data: { type: 'response.output_item.done', output_index: index, item },
});
async function streamPut(
  s: Ledger,
  input: unknown[],
  events: unknown[],
  o: Options = { thread: 'main', session: 'session' },
) {
  const value = envelope(input, '', o);
  value.report.response = { status: o.error ? 502 : 200, truncated: true, events };
  const bytes = Buffer.from(JSON.stringify(value)),
    result = await s.ingest(bytes);
  expect(hash(s.restore(result.id))).toBe(hash(bytes));
  return row(s, result.id);
}
function announcedEvents(reasonId: string, callId: string, completed = false) {
  const reason = reasoningItem(reasonId),
    call = callItem(callId);
  return [
    itemAdded(0, reason),
    itemDone(0, reason),
    itemAdded(1, call),
    ...(completed ? [itemDone(1, call)] : []),
  ];
}
test('41–44 partial tool-loop shape links ordered reasoning, completed calls and announced calls in one conversation', async () => {
  const s = store(),
    base = [user('do work')];
  const first = await streamPut(s, base, announcedEvents('reason41', 'tool41', true));
  const input42 = [...base, reasoningItem('reason41'), callItem('tool41'), toolResult('tool41')];
  const second = await streamPut(s, input42, announcedEvents('reason42', 'tool42'));
  const input43 = [
    ...input42,
    reasoningItem('reason42'),
    callItem('tool42', '{"received":"full arguments"}'),
    toolResult('tool42'),
  ];
  const third = await streamPut(s, input43, announcedEvents('reason43', 'tool43'));
  const last = await put(
    s,
    [
      ...input43,
      reasoningItem('reason43'),
      callItem('tool43'),
      toolResult('tool43'),
      user('optional new suffix'),
    ],
    'done',
    { thread: 'main', session: 'session' },
  );
  expect(second.parent_id).toBe(first.id);
  expect(second.link_rule).toBe('prefix_partial');
  expect(third.parent_id).toBe(second.id);
  expect(third.parent_coverage).toBe(input42.length);
  expect(third.link_rule).toBe('prefix_partial');
  expect(last.parent_id).toBe(third.id);
  expect(last.parent_coverage).toBe(input43.length);
  expect(last.link_rule).toBe('prefix_partial');
  for (const r of [first, second, third, last])
    expect(r.conversation_id).toBe(first.conversation_id);
  expect(last.turn_index).toBe(4);
  expect(conv(s, first.conversation_id).branch_count).toBe(0);
  const stored = JSON.parse(second.announced_output);
  expect(stored).toHaveLength(2);
  expect(stored[0].completedHash).toMatch(/^[a-f0-9]{64}$/);
  expect(stored[1].idHash).toMatch(/^[a-f0-9]{64}$/);
  expect(second.announced_output.includes('reason42')).toBe(false);
  expect(second.announced_output.includes('tool42')).toBe(false);
  expect(s.integrity().mismatches).toBe(0);
});
test('announced continuation rejects id/type/order/completed-payload mismatch and malformed announcement lists', async () => {
  for (const variant of [
    'id',
    'type',
    'order',
    'completed',
    'completed-id',
    'gap',
    'missing',
    'duplicate',
    'overflow',
    'oversized',
  ] as const) {
    const s = store(),
      base = [user(`base-${variant}`)],
      reason = reasoningItem('r'),
      call = callItem('c');
    let events = announcedEvents('r', 'c');
    if (variant === 'gap') events = [itemAdded(1, call)];
    if (variant === 'missing')
      events = [itemAdded(0, { type: 'function_call', name: 'tool', arguments: '' })];
    if (variant === 'duplicate') events = [itemAdded(0, call), itemAdded(1, call)];
    if (variant === 'overflow')
      events = Array.from({ length: 257 }, (_, i) => itemAdded(i, callItem(`c${i}`)));
    if (variant === 'oversized') events = [itemAdded(0, { ...call, id: 'x'.repeat(513) })];
    const parent = await streamPut(s, base, events);
    const echo: unknown[] = [reason, call];
    if (variant === 'id') echo[1] = callItem('different');
    if (variant === 'type') echo[1] = { type: 'reasoning', id: 'c', summary: [] };
    if (variant === 'order') echo.reverse();
    if (variant === 'completed-id') echo[0] = reasoningItem('different-reason');
    if (variant === 'completed')
      echo[0] = { ...reason, summary: [{ type: 'summary_text', text: 'changed' }] };
    const child = await put(s, [...base, ...echo, toolResult('c')], 'done', {
      thread: 'main',
      session: 'session',
    });
    expect(child.parent_id).toBeNull();
    if (['gap', 'missing', 'duplicate', 'overflow', 'oversized'].includes(variant)) {
      expect(parent.announcements_valid).toBe(0);
      expect(parent.announced_output).toBe('[]');
    }
  }
});
test('announced continuation requires exact input/domain/thread, excludes errors and undeclared requests', async () => {
  for (const variant of [
    'input',
    'thread',
    'token',
    'user',
    'protocol',
    'error',
    'undeclared',
    'previous',
  ] as const) {
    const s = store(),
      base = [user('base')];
    const options: Options = {
      thread: 'main',
      session: 'session',
      ...(variant === 'error' ? { error: true } : {}),
      ...(variant === 'undeclared' ? { thread: undefined } : {}),
      ...(variant === 'previous' ? { previous: 'unknown' } : {}),
    };
    const parent = await streamPut(s, base, announcedEvents('r', 'c'), options);
    const childOptions: Options = {
      thread: 'main',
      session: 'session',
      ...(variant === 'thread' ? { thread: 'other' } : {}),
      ...(variant === 'token' ? { tokenId: 2 } : {}),
      ...(variant === 'user' ? { userId: 2 } : {}),
      ...(variant === 'protocol' ? { format: 'openai' } : {}),
      ...(variant === 'undeclared' ? { thread: undefined } : {}),
    };
    const child = await put(
      s,
      [
        ...(variant === 'input' ? [user('changed')] : base),
        reasoningItem('r'),
        callItem('c'),
        toolResult('c'),
      ],
      'done',
      childOptions,
    );
    expect(child.parent_id).toBeNull();
    if (['error', 'undeclared', 'previous'].includes(variant))
      expect(parent.announcements_valid).toBe(0);
  }
});
test('announced candidates compete with prefix coverage, ties fail closed and dual-path same-parent is counted once', async () => {
  const s = store(),
    base = [user('base')];
  const both = await streamPut(s, base, announcedEvents('r', 'c', true));
  const child = await put(
    s,
    [...base, reasoningItem('r'), callItem('c'), toolResult('c')],
    'done',
    { thread: 'main', session: 'session' },
  );
  expect(child.parent_id).toBe(both.id);
  expect(child.context_reset).toBeNull();
  const a = await streamPut(s, [user('tie')], announcedEvents('r2', 'c2'));
  await streamPut(s, [user('tie')], announcedEvents('r2', 'c2'));
  const ambiguous = await put(
    s,
    [user('tie'), reasoningItem('r2'), callItem('c2'), toolResult('c2')],
    'done',
    { thread: 'main', session: 'session' },
  );
  expect(ambiguous.parent_id).toBeNull();
  expect(ambiguous.context_reset).toBe('no_prefix');
  expect(a.id).toBeGreaterThan(both.id);
  // A longer announced-item coverage beats a shorter complete-prefix candidate.
  const shared = [user('rank')];
  const shorter = await put(s, shared, 'answer', { thread: 'main', session: 'session' });
  const longBase = [...shared, assistant('answer'), user('new')];
  const longer = await streamPut(s, longBase, announcedEvents('r3', 'c3'));
  const winner = await put(
    s,
    [...longBase, reasoningItem('r3'), callItem('c3'), toolResult('c3')],
    'done',
    { thread: 'main', session: 'session' },
  );
  expect(winner.parent_id).toBe(longer.id);
  expect(winner.parent_id).not.toBe(shorter.id);
});

test('announced metadata mutation after prepare rejects the parent in the final transaction', async () => {
  const s = store(),
    base = [user('base')];
  const parent = await streamPut(s, base, announcedEvents('r', 'c'));
  const original = s.conversations.prepare.bind(s.conversations);
  s.conversations.prepare = (normalized, meta) => {
    expect(s.db.inTransaction).toBe(false);
    const prepared = original(normalized, meta);
    expect(prepared.parent?.id).toBe(parent.id);
    s.db
      .query("UPDATE requests SET announced_output='[]',announcements_valid=0 WHERE id=?")
      .run(parent.id);
    return prepared;
  };
  const child = await put(
    s,
    [...base, reasoningItem('r'), callItem('c'), toolResult('c')],
    'done',
    { thread: 'main', session: 'session' },
  );
  expect(child.parent_id).toBeNull();
  expect(child.parent_coverage).toBe(0);
  expect(child.context_reset).toBe('no_prefix');
  expect(s.integrity().mismatches).toBe(0);
});
test('announcement projections stay bounded and count toward storage accounting with indexed candidate lookup', async () => {
  const s = store(),
    base = [user('metadata')];
  const before = s.metrics().logical;
  const events = Array.from({ length: 256 }, (_, i) => itemAdded(i, callItem(`item-${i}`)));
  const parent = await streamPut(s, base, events);
  expect(parent.announcements_valid).toBe(1);
  const json = JSON.parse(parent.announced_output);
  expect(json).toHaveLength(256);
  expect(Buffer.byteLength(parent.announced_output)).toBeLessThanOrEqual(65_536);
  expect(s.metrics().logical - before).toBeGreaterThanOrEqual(
    Buffer.byteLength(parent.announced_output),
  );
  const planQuery = s.db.query<
    { detail: string },
    [string, string, string, string, string, string]
  >(
    "EXPLAIN QUERY PLAN SELECT id FROM requests WHERE source=? AND user_id=? AND token_id=? AND protocol=? AND thread_key=? AND completeness='partial' AND announcements_valid=1 AND input_chain IN (?)",
  );
  const plan = planQuery.all(
    'synthetic',
    '1',
    '1',
    'openai_responses',
    parent.thread_key!,
    parent.input_chain!,
  );
  planQuery.finalize();
  expect(plan.some((r) => r.detail.includes('requests_partial_input'))).toBe(true);
  const echo = Array.from({ length: 256 }, (_, i) => callItem(`item-${i}`));
  const child = await put(s, [...base, ...echo, user('suffix')], 'done', {
    thread: 'main',
    session: 'session',
  });
  expect(child.parent_id).toBe(parent.id);
  expect(child.parent_coverage).toBe(base.length);
});

test('completed partial-body output cannot use announced ids to accept an edited payload', async () => {
  const s = store(),
    base = [user('partial-body')],
    call = callItem('body-call', '{"exact":true}');
  const value = envelope(base, '', { thread: 'main', session: 'session' });
  value.report.response = {
    status: 200,
    truncated: true,
    body: { status: 'incomplete', output: [call] },
    events: [itemAdded(0, { ...call, status: 'in_progress', arguments: '' })],
  };
  const bytes = Buffer.from(JSON.stringify(value));
  const inserted = await s.ingest(bytes),
    parent = row(s, inserted.id);
  expect(JSON.parse(parent.announced_output)[0].completedHash).toHaveLength(64);
  const edited = await put(
    s,
    [...base, callItem('body-call', '{"exact":false}'), toolResult('body-call')],
    'done',
    { thread: 'main', session: 'session' },
  );
  expect(edited.parent_id).toBeNull();
  const exact = await put(s, [...base, call, toolResult('body-call')], 'done', {
    thread: 'main',
    session: 'session',
  });
  expect(exact.parent_id).toBe(parent.id);
  expect(s.restore(parent.id)).toEqual(bytes);
});
test('v4 corrupt evidence never partially publishes newer metadata', async () => {
  const c = config(),
    s = store(c);
  const p = await streamPut(s, [user('base')], announcedEvents('r', 'c'));
  downgradeV4(s);
  s.db.query('UPDATE requests SET body_hash=? WHERE id=?').run('0'.repeat(64), p.id);
  const original = s.db.query('SELECT id,conversation_id,turn_index FROM requests').all();
  s.close();
  stores.splice(stores.indexOf(s), 1);
  expect(() => new Ledger(c)).toThrow();
  const db = new Database(c.database);
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
  expect(db.query('SELECT id,conversation_id,turn_index FROM requests').all()).toEqual(original);
  expect(
    (db.query('PRAGMA table_info(requests)').all() as { name: string }[]).some(
      (c) => c.name === 'announced_output',
    ),
  ).toBe(false);
  db.close();
});

test('announced continuation preserves empty and system-only input parent exclusion', async () => {
  for (const base of [[], [{ role: 'system', content: 'system-only' }]]) {
    const s = store(),
      parent = await streamPut(s, base, announcedEvents('r', 'c'));
    const child = await put(
      s,
      [...base, reasoningItem('r'), callItem('c'), toolResult('c')],
      'done',
      { thread: 'main', session: 'session' },
    );
    expect(parent.announcements_valid).toBe(0);
    expect(parent.evidence_chain).toBeNull();
    expect(child.parent_id).toBeNull();
  }
});
