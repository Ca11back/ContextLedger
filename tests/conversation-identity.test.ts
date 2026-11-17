import { expect, test } from 'bun:test';
import type { Envelope } from '../src/contracts';
import { hash } from '../src/server/codec';
import {
  type IsolationDomain,
  identityKey,
  isolationDomain,
  parseCodexIdentity,
} from '../src/server/identity';
import { normalizeEnvelope } from '../src/server/normalize';

const domain: IsolationDomain = {
  source: 'source',
  userId: '1',
  tokenId: '2',
  protocol: 'openai_responses',
};
const body = (declaration: unknown, extra: object = {}) => ({
  client_metadata: { 'x-codex-turn-metadata': JSON.stringify(declaration), ...extra },
});
test('thread and parent share an exact versioned hash namespace; other axes isolate identity', () => {
  const parent = parseCodexIdentity(
    body({ thread_id: 'parent', session_id: 'session', window_id: 'window' }),
    domain,
  )!;
  const child = parseCodexIdentity(
    body({ thread_id: 'child', parent_thread_id: 'parent', session_id: 'session' }),
    domain,
  )!;
  expect(child.parentThreadKey).toBe(parent.threadKey);
  expect(parent.sessionKey).toBe(child.sessionKey);
  expect(parent.threadKey).toBe(
    hash(JSON.stringify(['cl-id-v1', 'source', '1', '2', 'openai_responses', 'thread', 'parent'])),
  );
  for (const field of ['source', 'userId', 'tokenId', 'protocol'] as const)
    expect(identityKey({ ...domain, [field]: 'different' }, 'thread', 'parent')).not.toBe(
      parent.threadKey,
    );
  expect(identityKey(domain, 'session', 'parent')).not.toBe(parent.threadKey);
});

test('invalid or missing thread metadata is undeclared; session/cache keys alone never identify a thread', () => {
  for (const value of [
    null,
    {},
    { session_id: 'shared' },
    { thread_id: '' },
    { thread_id: 42 },
    { thread_id: 'x'.repeat(257) },
  ])
    expect(parseCodexIdentity(body(value), domain)).toBeNull();
  expect(
    parseCodexIdentity({ client_metadata: { 'x-codex-turn-metadata': 'invalid json' } }, domain),
  ).toBeNull();
  expect(
    parseCodexIdentity({ prompt_cache_key: 'shared', session_id: 'shared' }, domain),
  ).toBeNull();
  expect(parseCodexIdentity(body({ thread_id: 'valid' }), null)).toBeNull();
});

test('identity bounds apply to full strings, window fallback and display fields', () => {
  const parsed = parseCodexIdentity(
    body(
      {
        thread_id: 'x'.repeat(256),
        session_id: 's'.repeat(257),
        parent_thread_id: 'p',
        window_id: '',
        agent_name: 'a'.repeat(65),
        subagent_kind: 'k'.repeat(33),
      },
      { 'x-codex-window-id': 'fallback' },
    ),
    domain,
  )!;
  expect(parsed.threadKey).toHaveLength(64);
  expect(parsed.sessionKey).toBeNull();
  expect(parsed.windowKey).toBe(identityKey(domain, 'window', 'fallback'));
  expect(parsed.agentName).toBeNull();
  expect(parsed.subagentKind).toBeNull();
  const display = parseCodexIdentity(
    body({ thread_id: 'valid', agent_name: '<b>agent</b>', subagent_kind: 'worker' }),
    domain,
  )!;
  expect(display.agentName).toBe('<b>agent</b>'); // Escaping belongs to the rendering layer.
});

test('missing user/token ids prevent linking; labels never substitute for IDs', () => {
  const raw: Envelope = {
    version: 1,
    upload_id: 'test',
    source: 'source',
    context: { format: 'openai_responses' },
    report: {
      user: { username: 'name' },
      token: { name: 'token' },
      request: { body: body({ thread_id: 'thread' }) },
    },
  };
  expect(isolationDomain(raw, 'openai_responses')).toBeNull();
  expect(normalizeEnvelope(raw).identity).toBeNull();
  raw.report.user = { id: 1, username: 'name' };
  raw.report.token = { id: 2, name: 'token' };
  expect(isolationDomain(raw, 'openai_responses')).toEqual(domain);
  expect(normalizeEnvelope(raw).identity?.threadKey).toBe(identityKey(domain, 'thread', 'thread'));
});

test('declarations remain explicit for storage conflict/self/cycle checks without guessing relationships', () => {
  const one = parseCodexIdentity(
    body({ thread_id: 'self', session_id: 's', parent_thread_id: 'self' }),
    domain,
  )!;
  expect(one.parentThreadKey).toBe(one.threadKey);
  const conflicting = parseCodexIdentity(
    body({ thread_id: 'self', session_id: 'other', parent_thread_id: 'parent' }),
    domain,
  )!;
  expect(one.threadKey).toBe(conflicting.threadKey);
  expect(one.sessionKey).not.toBe(conflicting.sessionKey);
  expect(one.parentThreadKey).not.toBe(conflicting.parentThreadKey);
});
