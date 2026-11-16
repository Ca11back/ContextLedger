import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/server/config';
import { LedgerError } from '../src/server/errors';
import { recordView, recordViewHttp } from '../src/server/record-view';
import { Ledger } from '../src/server/storage';
import { RECORD_VIEW_MAX_BYTES, type RecordView } from '../src/view-contracts';

const fixtures: { store: Ledger; directory: string }[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-view-test-'));
  const config: Config = {
    database: join(directory, 'ledger.sqlite'),
    maxStorageBytes: 64 * 1024 * 1024,
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

function envelope(report: unknown) {
  return {
    version: 1,
    upload_id: crypto.randomUUID(),
    source: 'synthetic',
    context: { model: 'synthetic-model' },
    report,
    capture: { profile: 'readable-v1', lifecycle_residue: [] },
  };
}

function query(path: string[], offset = 0, limit = 20) {
  return new URLSearchParams({
    path: JSON.stringify(path),
    offset: String(offset),
    limit: String(limit),
  });
}

function bounded(view: RecordView) {
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(RECORD_VIEW_MAX_BYTES);
  expect(view.entries.length).toBeLessThanOrEqual(25);
  expect(view.node.preview.length).toBeLessThanOrEqual(160);
  expect(view.text?.length ?? 0).toBeLessThanOrEqual(8192);
}

function errorCode(action: () => unknown, status: number, code: string) {
  try {
    action();
    throw new Error('expected view error');
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).status).toBe(status);
    expect((error as LedgerError).code).toBe(code);
  }
}

afterEach(() => {
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('multi-MiB evidence is inspected as immediate children and retains exact stored bytes', async () => {
  const store = fixture();
  const body = JSON.stringify(
    envelope({
      request: {
        body: {
          messages: Array.from({ length: 10000 }, (_, index) => ({
            role: 'user',
            content: `${index} ${'中😀'.repeat(100)}`,
          })),
        },
      },
      response: {
        status: 200,
        body: { output: '<script>never execute</script>' },
        events: [{ type: 'future', unknown: true }],
      },
      unknown: { hidden: 'must remain available' },
    }),
  ).replace('"report":', '"duplicate":1e+03,"duplicate":-0,\n"report":');
  expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
  const { id } = await store.ingest(Buffer.from(body));
  const root = recordView(store, id, new URLSearchParams());
  bounded(root);
  expect(root.entries.find((item) => item.key === 'report')).toMatchObject({
    kind: 'object',
    preview: '',
    count: 3,
  });
  expect(root.sections).toEqual([
    { id: 'request', label: '输入', path: ['report', 'request'] },
    { id: 'response', label: '输出', path: ['report', 'response', 'body'] },
    { id: 'events', label: '事件', path: ['report', 'response', 'events'] },
    { id: 'capture', label: '采集说明', path: ['capture'] },
    { id: 'context', label: '上下文', path: ['context'] },
    { id: 'raw', label: '完整结构', path: [] },
  ]);
  const messages = ['report', 'request', 'body', 'messages'];
  const first = recordView(store, id, query(messages));
  bounded(first);
  expect(first.total).toBe(10000);
  expect(first.entries).toHaveLength(20);
  expect(first.entries[0]).toEqual({
    key: '0',
    path: [...messages, '0'],
    kind: 'object',
    preview: '',
    count: 2,
  });
  expect(first.nextOffset).toBe(20);
  const last = recordView(store, id, query(messages, 9995, 25));
  bounded(last);
  expect(last.entries.map((item) => item.key)).toEqual(['9995', '9996', '9997', '9998', '9999']);
  expect(last.nextOffset).toBeNull();
  expect(recordView(store, id, query(['report', 'unknown', 'hidden'])).text).toBe(
    'must remain available',
  );
  expect(store.detail(id).received_json).toBe(body);
  expect(Buffer.from(store.restore(id)).toString()).toBe(body);
  expect(store.integrity().mismatches).toBe(0);
});

test('long escaped text pages reconstruct exactly across surrogate boundaries', async () => {
  const store = fixture();
  const text = `${'a'.repeat(8191)}😀${'\u0000\\"中😀'.repeat(10000)}<img src="https://invalid.example">`;
  const { id } = await store.ingest(Buffer.from(JSON.stringify(envelope({ text }))));
  let restored = '',
    offset = 0,
    calls = 0;
  do {
    const view = recordView(store, id, query(['report', 'text'], offset));
    bounded(view);
    expect(view.offset).toBe(offset);
    expect(view.total).toBe(text.length);
    restored += view.text;
    calls++;
    if (view.nextOffset === null) break;
    expect(view.nextOffset).toBe(offset + view.text!.length);
    expect(view.nextOffset).toBeGreaterThan(offset);
    const code = view.text!.charCodeAt(view.text!.length - 1);
    expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
    offset = view.nextOffset;
  } while (calls < 100);
  expect(calls).toBeGreaterThan(2);
  expect(restored).toBe(text);
  errorCode(
    () => recordView(store, id, query(['report', 'text'], 8192)),
    400,
    'invalid_view_offset',
  );
  expect(recordView(store, id, query(['report', 'text'], text.length))).toMatchObject({
    text: '',
    nextOffset: null,
  });
});

test('large escaped paths reduce pages according to serialized UTF-8 budget', async () => {
  const store = fixture();
  const path = Array.from({ length: 14 }, () => '中'.repeat(500));
  let nested: Record<string, unknown> = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [String(i), 'value']),
  );
  for (const key of [...path].reverse()) nested = { [key]: nested };
  const { id } = await store.ingest(Buffer.from(JSON.stringify(envelope(nested))));
  const requested = ['report', ...path];
  let offset = 0;
  const seen: string[] = [];
  while (true) {
    const view = recordView(store, id, query(requested, offset, 25));
    bounded(view);
    expect(view.entries.length).toBeLessThan(25);
    seen.push(...view.entries.map((item) => item.key));
    if (view.nextOffset === null) break;
    expect(view.nextOffset).toBeGreaterThan(offset);
    offset = view.nextOffset;
  }
  expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => String(i)));
});

test('text chunks also shrink when escaped text and long UTF-8 paths share the response budget', async () => {
  const store = fixture();
  const path = Array.from({ length: 14 }, () => '中'.repeat(500));
  const text = '\u0000'.repeat(20000);
  let nested: unknown = text;
  for (const key of [...path].reverse()) nested = { [key]: nested };
  const { id } = await store.ingest(Buffer.from(JSON.stringify(envelope(nested))));
  let offset = 0,
    reconstructed = '';
  while (true) {
    const view = recordView(store, id, query(['report', ...path], offset));
    bounded(view);
    expect(view.text!.length).toBeLessThan(8192);
    reconstructed += view.text;
    if (view.nextOffset === null) break;
    expect(view.nextOffset).toBe(offset + view.text!.length);
    offset = view.nextOffset;
  }
  expect(reconstructed).toBe(text);
});

test('key and depth limits are explicit, and own prototype-named values remain inspectable', async () => {
  const store = fixture();
  const oversized = '😀'.repeat(300);
  const report = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":{"prototype":"own data"},"array":[1],"empty":{},"nil":null}',
  );
  report[oversized] = 'not silently renamed';
  report.deep = { end: true };
  for (let i = 0; i < 31; i++) report.deep = { next: report.deep };
  const { id } = await store.ingest(Buffer.from(JSON.stringify(envelope(report))));
  expect(recordView(store, id, query(['report', '__proto__', 'safe'])).node.preview).toBe('true');
  expect(recordView(store, id, query(['report', 'constructor', 'prototype'])).text).toBe(
    'own data',
  );
  errorCode(() => recordView(store, id, query(['report', 'toString'])), 404, 'view_path_not_found');
  errorCode(
    () => recordView(store, id, query(['report', '__proto__', 'polluted'])),
    404,
    'view_path_not_found',
  );
  errorCode(
    () => recordView(store, id, query(['report', 'array', '00'])),
    400,
    'invalid_array_index',
  );
  errorCode(
    () => recordView(store, id, query(['report', 'array', 'length'])),
    400,
    'invalid_array_index',
  );
  errorCode(
    () => recordView(store, id, query(['report', 'array', '1'])),
    404,
    'view_path_not_found',
  );
  const view = recordView(store, id, query(['report']));
  const unavailable = view.entries.find((item) => item.unavailable === 'key_limit')!;
  expect(unavailable.path).toBeNull();
  expect(unavailable.key.length).toBeLessThanOrEqual(512);
  expect(unavailable.key.endsWith('…')).toBe(true);
  const deepest = ['report', 'deep', ...Array<string>(30).fill('next')];
  const boundary = recordView(store, id, query(deepest));
  bounded(boundary);
  expect(boundary.entries[0]).toMatchObject({ path: null, unavailable: 'path_limit' });
  expect(recordView(store, id, query(['report', 'empty']))).toMatchObject({
    entries: [],
    total: 0,
    nextOffset: null,
  });
  expect(recordView(store, id, query(['report', 'nil']))).toMatchObject({
    node: { kind: 'null', preview: 'null', count: 0 },
    text: null,
  });
  expect(store.detail(id).received_json).toContain(oversized);
});

test('invalid ids, paths and pagination fail before restoring stored content', async () => {
  const store = fixture();
  const spy = spyOn(store, 'detail');
  const invalid: [string, string][] = [
    ['path={}', 'invalid_view_path'],
    ['path=[1]', 'invalid_view_path'],
    ['path=%5B', 'invalid_view_path'],
    [`path=${JSON.stringify(['a'.repeat(513)])}`, 'invalid_view_path'],
    [`path=${JSON.stringify(Array(33).fill('x'))}`, 'invalid_view_path'],
    [`path=${' '.repeat(8193)}`, 'view_path_too_large'],
    ['offset=-1', 'invalid_view_offset'],
    ['offset=1.5', 'invalid_view_offset'],
    ['offset=Infinity', 'invalid_view_offset'],
    ['offset=9007199254740992', 'invalid_view_offset'],
    ['limit=0', 'invalid_view_limit'],
    ['limit=26', 'invalid_view_limit'],
    ['limit=2e1', 'invalid_view_limit'],
  ];
  for (const [params, code] of invalid)
    errorCode(() => recordView(store, 1, new URLSearchParams(params)), 400, code);
  for (const id of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    errorCode(() => recordView(store, id, new URLSearchParams()), 400, 'invalid_id');
  }
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
  errorCode(() => recordView(store, 1, new URLSearchParams()), 404, 'record_not_found');
});

test('view HTTP authenticates independently and returns bounded private errors', async () => {
  const store = fixture();
  const { id } = await store.ingest(
    Buffer.from(JSON.stringify(envelope({ text: '<script>alert(1)</script>' }))),
  );
  const url = `http://local/api/records/${id}/view?path=${encodeURIComponent('["report","text"]')}`;
  const request = (authorization = '') =>
    new Request(url, { headers: { Authorization: authorization } });
  const spy = spyOn(store, 'detail');
  for (const authorization of [
    '',
    `Bearer ${store.config.ingestToken}`,
    `Basic ${btoa('admin:wrong')}`,
  ]) {
    const response = recordViewHttp(request(authorization), store, String(id));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('www-authenticate')).toContain('Basic');
  }
  expect(spy).not.toHaveBeenCalled();
  const admin = `Basic ${btoa(`admin:${store.config.adminPassword}`)}`;
  const response = recordViewHttp(request(admin), store, String(id));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const view = (await response.json()) as RecordView;
  bounded(view);
  expect(view.text).toBe('<script>alert(1)</script>');
  for (const invalid of ['0', '-1', '1.2', '1e0', '9007199254740992']) {
    expect(recordViewHttp(request(admin), store, invalid).status).toBe(400);
  }
  expect(recordViewHttp(request(admin), store, '999').status).toBe(404);
  spy.mockRestore();
  const beyond = recordViewHttp(
    new Request(`${url}&offset=999`, { headers: { Authorization: admin } }),
    store,
    String(id),
  );
  expect(beyond.status).toBe(400);
  expect(await beyond.json()).toEqual({ error: 'invalid_view_offset' });
});

test('retained-away evidence becomes 404 after inspection without serving a cached document', async () => {
  const store = fixture();
  store.config.maxAgeDays = 1;
  const { id } = await store.ingest(
    Buffer.from(JSON.stringify(envelope({ text: 'expired evidence' }))),
    {
      receivedAt: Date.now() - 3 * 86400000,
    },
  );
  expect(recordView(store, id, query(['report', 'text'])).text).toBe('expired evidence');
  await store.maintain();
  errorCode(() => recordView(store, id, query(['report', 'text'])), 404, 'record_not_found');
});
