import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../src/contracts';
import { hash } from '../src/server/codec';
import type { Config } from '../src/server/config';
import { requestIndexColumns } from '../src/server/linking';
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
                  data: { type: 'response.output_item.done', item: output[0] },
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
  completeness: string;
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

test('exact prefix chains, retries as branches, longest coverage and immutable own turn sequence', async () => {
  const s = store(),
    a = await put(s, [user('a')], 'A'),
    b = await put(s, [user('a'), assistant('A'), user('b')], 'B');
  const retry = await put(s, [user('a'), assistant('A'), user('b')], 'B2');
  const c = await put(s, [user('a'), assistant('A'), user('b'), assistant('B'), user('c')], 'C');
  expect(b.parent_id).toBe(a.id);
  expect(b.conversation_id).toBe(a.conversation_id);
  expect(b.turn_index).toBe(2);
  expect(retry.parent_id).toBe(a.id);
  expect(retry.conversation_id).not.toBe(a.conversation_id);
  expect(retry.turn_index).toBe(1);
  expect(conv(s, retry.conversation_id).forked_from_turn).toBe(1);
  expect(conv(s, retry.conversation_id).inherited_turns).toBe(1);
  expect(c.parent_id).toBe(b.id);
  expect(c.turn_index).toBe(3);
  expect(conv(s, a.conversation_id).own_turns).toBe(3);
  expect(conv(s, a.conversation_id).branch_count).toBe(1);
  remove(s, b.id);
  expect(row(s, c.id).turn_index).toBe(3);
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
  expect(d.turn_index).toBe(4);
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
  s.db.exec(
    'DROP TABLE conversation_models; DROP TABLE threads; DROP TABLE conversations; DROP INDEX requests_evidence; DROP INDEX requests_response; DROP INDEX requests_thread; DROP INDEX requests_session; DROP INDEX requests_parent_thread; DROP INDEX requests_conversation; DROP INDEX requests_parent; DROP INDEX requests_conversation_time;',
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
  expect(restarted.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
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
