import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, prepare } from '../src/server/codec';
import type { Config } from '../src/server/config';
import { loadConfig } from '../src/server/config';
import { adminHttp, ingestHttp } from '../src/server/http';
import { Ledger } from '../src/server/storage';
import { literalManifest } from './transfer-helpers';

const temporary: string[] = [],
  stores: Ledger[] = [];
export function config(overrides: Partial<Config> = {}): Config {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  temporary.push(directory);
  return {
    database: join(directory, 'ledger.sqlite'),
    maxStorageBytes: 8 * 1024 * 1024,
    reserveBytes: 256 * 1024,
    maxBodyBytes: 1024 * 1024,
    adminUser: 'admin',
    adminPassword: 'synthetic-admin-password',
    ingestToken: 'synthetic-ingest-token-12345678',
    source: 'synthetic',
    maintenanceMs: 30000,
    ...overrides,
  };
}
function store(overrides: Partial<Config> = {}) {
  const result = new Ledger(config(overrides));
  stores.push(result);
  return result;
}
export function envelope(
  report: unknown = {
    request: {
      body: {
        messages: [
          { role: 'user', content: '中文 😀 repeated' },
          { role: 'user', content: '中文 😀 repeated' },
        ],
      },
    },
    response: {
      status: 200,
      truncated: false,
      events: [{ event: 'unknown', data: { type: 'future', text: '<script>alert(1)</script>' } }],
    },
  },
) {
  return {
    version: 1,
    upload_id: crypto.randomUUID(),
    source: 'synthetic',
    context: { model: 'synthetic-model', channel: { id: 1 } },
    report,
  };
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true });
});
test('configuration requires explicit quota and distinct credentials', () => {
  expect(() => loadConfig({})).toThrow();
  expect(() =>
    loadConfig({
      LEDGER_MAX_STORAGE_MB: '8',
      LEDGER_ADMIN_PASSWORD: 'same-synthetic-token-123456789',
      LEDGER_INGEST_TOKEN: 'same-synthetic-token-123456789',
      LEDGER_SOURCE: 'synthetic',
    }),
  ).toThrow();
});
test('public ingest preserves bytes, unknown fields, duplicate members, spelling and item order', async () => {
  const s = store(),
    value = envelope();
  const json = JSON.stringify(value).replace(
    '"report":',
    '"unknown":1e+03, "unknown":-0, "escaped":"\\u4e2d",\n"report":',
  );
  const result = await s.ingest(Buffer.from(json));
  expect(Buffer.from(s.restore(result.id)).toString()).toBe(json);
  expect(s.detail(result.id).meta.storage_mode).toBe('item_cas');
  expect(s.integrity()).toEqual({ checked: 1, mismatches: 0, rebuilt: false });
  const shared = s.db
    .query<{ refcount: number }, []>('SELECT refcount FROM objects WHERE length>10')
    .all();
  expect(shared.every((row) => row.refcount === 1)).toBe(true);
  const retry = await s.ingest(Buffer.from(json));
  expect(retry.duplicate).toBe(true);
  expect(s.metrics().records).toBe(1);
  await expect(s.ingest(Buffer.from(json.replace('1e+03', '1e+04')))).rejects.toThrow(
    'upload_id_conflict',
  );
  expect(s.integrity().mismatches).toBe(0);
});
test('whole fallback and forced representation both restore exactly', async () => {
  const s = store(),
    body = encoded(envelope({ arbitrary: { future: null } }));
  const result = await s.ingest(body);
  expect(s.detail(result.id).meta.storage_mode).toBe('whole_zstd');
  expect(s.restore(result.id)).toEqual(body);
  const cas = encoded(envelope());
  const forced = await s.ingest(cas, { forceWhole: true });
  expect(s.detail(forced.id).meta.storage_mode).toBe('whole_zstd');
  expect(s.restore(forced.id)).toEqual(cas);
  expect((await prepare(Buffer.from('{bad'))).mode).toBe('whole_zstd');
});
test('distinct-root references survive age GC, restart and backup restore', async () => {
  const s = store({ maxAgeDays: 1 });
  const old = await s.ingest(encoded(envelope()), { receivedAt: Date.now() - 3 * 86400000 });
  const fresh = await s.ingest(encoded(envelope()));
  await s.maintain();
  expect(() => s.restore(old.id)).toThrow('record_not_found');
  expect(s.restore(fresh.id).length).toBeGreaterThan(0);
  expect(s.integrity().mismatches).toBe(0);
  const backup = join(dirname(s.config.database), 'backup.sqlite');
  s.backup(backup);
  const restored = new Ledger({ ...s.config, database: backup });
  stores.push(restored);
  expect(restored.restore(fresh.id)).toEqual(s.restore(fresh.id));
  expect(restored.integrity().mismatches).toBe(0);
});

import { dirname } from 'node:path';

test('corrupt/missing object fails loudly and transaction refcounts roll back', async () => {
  const s = store();
  const result = await s.ingest(encoded(envelope()));
  const item = s.db.query<{ hash: string }, []>('SELECT hash FROM objects LIMIT 1').get()!;
  s.db.query('UPDATE objects SET compressed=? WHERE hash=?').run(Buffer.from('broken'), item.hash);
  expect(() => s.restore(result.id)).toThrow();
  await expect(s.ingest(encoded(envelope()))).rejects.toThrow();
  expect(s.metrics().records).toBe(1);
});
test('ambiguous corrupt manifest cannot mutate root reference counts during retention', async () => {
  const s = store({ maxAgeDays: 1 });
  const old = await s.ingest(encoded(envelope()), { receivedAt: Date.now() - 3 * 86400000 });
  const ref = s.db.query<{ hash: string }, []>('SELECT hash FROM objects LIMIT 1').get()!.hash;
  s.db
    .query('UPDATE requests SET payload=? WHERE id=?')
    .run(Bun.zstdCompressSync(JSON.stringify([{ literal: 'changed', hash: ref }])), old.id);
  const before = s.db.query('SELECT hash,refcount FROM objects ORDER BY hash').all();
  expect(() => s.restore(old.id)).toThrow('manifest_integrity_error');
  await expect(s.maintain()).rejects.toThrow('manifest_integrity_error');
  expect(s.metrics().records).toBe(1);
  expect(s.db.query('SELECT hash,refcount FROM objects ORDER BY hash').all()).toEqual(before);
});
test('space rotation is bounded, retains shared history and validates refcounts', async () => {
  const s = store({ maxStorageBytes: 1024 * 1024, reserveBytes: 128 * 1024 });
  for (let i = 0; i < 320; i++) {
    const report = {
      request: {
        body: {
          messages: Array.from({ length: 12 }, (_, n) => ({
            role: 'user',
            content: 'shared history '.repeat(80) + n,
          })),
          instructions: 'stable instructions'.repeat(40),
        },
      },
      response: {
        body: {
          text: Buffer.from(crypto.getRandomValues(new Uint8Array(2000))).toString('base64'),
        },
      },
    };
    await s.ingest(encoded(envelope(report)));
  }
  const m = s.metrics();
  expect(m.allocated).toBeLessThanOrEqual(s.config.maxStorageBytes);
  expect(m.records).toBeGreaterThan(0);
  expect(m.records).toBeLessThan(320);
  expect(s.integrity().mismatches).toBe(0);
  for (const row of s.list(new URLSearchParams()).rows)
    expect(hash(s.restore(row.id))).toBe(row.body_hash);
});
test('large inadmissible write does not erase old history', async () => {
  const s = store({ maxStorageBytes: 1024 * 1024, reserveBytes: 128 * 1024 });
  const first = await s.ingest(encoded(envelope()));
  // Use independently random blocks to avoid accidental compression savings.
  const random = encoded(
    envelope({
      random: Array.from({ length: 8 }, () =>
        Buffer.from(crypto.getRandomValues(new Uint8Array(65536))).toString('base64'),
      ),
    }),
  );
  await expect(s.ingest(random)).rejects.toThrow('record_exceeds_storage_budget');
  expect(s.restore(first.id).length).toBeGreaterThan(0);
});
test('shared large history is admitted using only incremental object cost', async () => {
  const s = store({ maxStorageBytes: 1024 * 1024, reserveBytes: 128 * 1024 });
  const messages = Array.from({ length: 18 }, () => ({
    role: 'user',
    content: Buffer.from(crypto.getRandomValues(new Uint8Array(16384))).toString('base64'),
  }));
  for (const message of messages)
    await s.ingest(encoded(envelope({ request: { body: { messages: [message] } } })));
  const count = s.metrics().objects;
  const body = encoded(envelope({ request: { body: { messages } } }));
  const result = await s.ingest(body);
  expect(s.restore(result.id)).toEqual(body);
  expect(s.metrics().objects).toBe(count);
  expect(s.metrics().allocated).toBeLessThanOrEqual(s.config.maxStorageBytes);
  expect(s.integrity().mismatches).toBe(0);
});
test('blocked small WAL stops retention before deleting roots', async () => {
  const s = store({ maxStorageBytes: 4 * 1024 * 1024, reserveBytes: 256 * 1024 });
  await s.ingest(encoded(envelope()));
  await s.ingest(encoded(envelope()));
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const reader = new Database(s.config.database, { readonly: true });
  reader.exec('BEGIN');
  reader.query('SELECT count(*) FROM requests').get();
  try {
    s.db.exec('UPDATE maintenance_lease SET epoch=epoch+1');
    expect(s.metrics().wal).toBeGreaterThan(0);
    expect(s.metrics().wal).toBeLessThan(s.config.reserveBytes);
    const count = s.metrics().records;
    await s.maintain(s.config.maxStorageBytes);
    expect(s.metrics().records).toBe(count);
    expect(s.metrics().pressure).toBe('wal_checkpoint_blocked');
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
  }
});
test('shared scattered roots stop after three batches with no reclaimed pages', async () => {
  const s = store({ maxStorageBytes: 4 * 1024 * 1024, reserveBytes: 128 * 1024 });
  const report = {
    request: {
      body: {
        messages: [
          {
            role: 'user',
            content: Buffer.from(crypto.getRandomValues(new Uint8Array(16384))).toString('base64'),
          },
        ],
      },
    },
  };
  const now = Date.now();
  for (let i = 0; i < 256; i++)
    await s.ingest(encoded(envelope(report)), {
      receivedAt: now - (i % 4 === 0 ? 3 * 86400000 : 0),
    });
  const before = s.metrics();
  await s.maintain(s.config.maxStorageBytes);
  const after = s.metrics();
  expect(after.pressure).toBe('maintenance_no_progress');
  expect(before.records - after.records).toBeLessThan(64);
  expect(after.records).toBeGreaterThan(0);
  expect(s.integrity().mismatches).toBe(0);
});
test('shared object verification runs outside the ingestion write transaction', async () => {
  const s = store();
  await s.ingest(encoded(envelope()));
  const decompress = Bun.zstdDecompressSync;
  const spy = spyOn(Bun, 'zstdDecompressSync').mockImplementation((...args) => {
    expect(s.db.inTransaction).toBe(false);
    return decompress(...args);
  });
  try {
    await s.ingest(encoded(envelope()));
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
test('all HTTP data boundaries authenticate, cap streaming body and separate tokens', async () => {
  const s = store();
  const request = (
    authorization: string,
    body = JSON.stringify(literalManifest(JSON.stringify(envelope()))),
  ) =>
    new Request('http://local/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body,
    });
  expect((await ingestHttp(request(''), s)).status).toBe(401);
  expect(
    (await ingestHttp(request('Basic ' + btoa('admin:' + s.config.adminPassword)), s)).status,
  ).toBe(401);
  expect((await ingestHttp(request('Bearer ' + s.config.ingestToken), s)).status).toBe(200);
  expect(
    adminHttp(new Request('http://local/api/records'), s, () => s.list(new URLSearchParams()))
      .status,
  ).toBe(401);
  expect(
    adminHttp(
      new Request('http://local/api/records', {
        headers: { Authorization: 'Bearer ' + s.config.ingestToken },
      }),
      s,
      () => s.detail(1),
    ).status,
  ).toBe(401);
  const auth = new Request('http://local/api/records', {
    headers: { Authorization: 'Basic ' + btoa('admin:' + s.config.adminPassword) },
  });
  expect(adminHttp(auth, s, () => s.detail(1)).status).toBe(200);
  expect(
    (
      await ingestHttp(
        request('Bearer ' + s.config.ingestToken, 'a'.repeat(s.config.maxBodyBytes + 1)),
        s,
      )
    ).status,
  ).toBe(413);
});
test('filters and cursor pages return metadata without decompressing bodies', async () => {
  const s = store();
  for (let i = 0; i < 4; i++) await s.ingest(encoded(envelope()));
  const first = s.list(new URLSearchParams('model=synthetic-model&limit=2'));
  expect(first.rows.length).toBe(2);
  const second = s.list(new URLSearchParams('cursor=' + first.cursor));
  expect(second.rows.length).toBe(2);
  expect(first.rows[1]!.id).toBeGreaterThan(second.rows[0]!.id);
});

test('offline integrity rebuild repairs derived zero counts after verifying evidence', async () => {
  const s = store();
  const result = await s.ingest(encoded(envelope()));
  s.db.exec('UPDATE objects SET refcount=0');
  expect(() => s.restore(result.id)).toThrow('missing_object');
  expect(s.integrity().mismatches).toBeGreaterThan(0);
  expect(s.integrity(true).rebuilt).toBe(true);
  expect(s.restore(result.id).length).toBeGreaterThan(0);
  expect(s.integrity().mismatches).toBe(0);
});
test('maintenance respects another owner lease then recovers after expiry', async () => {
  const s = store({ maxAgeDays: 1 });
  const result = await s.ingest(encoded(envelope()), { receivedAt: Date.now() - 3 * 86400000 });
  s.db
    .query('UPDATE maintenance_lease SET owner=?,expires=?')
    .run('other-process', Date.now() + 60_000);
  await s.maintain();
  expect(s.restore(result.id).length).toBeGreaterThan(0);
  s.db.exec('UPDATE maintenance_lease SET expires=0');
  await s.maintain();
  expect(() => s.restore(result.id)).toThrow('record_not_found');
});

import { Database } from 'bun:sqlite';

test('pinned WAL stops admission and maintenance without erasing shared roots', async () => {
  const s = store({ maxStorageBytes: 4 * 1024 * 1024, reserveBytes: 64 * 1024 });
  const first = await s.ingest(encoded(envelope()));
  const reader = new Database(s.config.database, { readonly: true });
  reader.exec('BEGIN');
  reader.query('SELECT count(*) FROM requests').get();
  let refused = false;
  try {
    for (let i = 0; i < 20; i++) {
      try {
        await s.ingest(
          encoded(
            envelope({
              request: {
                body: {
                  messages: [
                    {
                      role: 'user',
                      content: Buffer.from(crypto.getRandomValues(new Uint8Array(8192))).toString(
                        'base64',
                      ),
                    },
                  ],
                },
              },
            }),
          ),
        );
      } catch (error) {
        expect((error as Error).message).toBe('storage_pressure');
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
    const count = s.metrics().records;
    await s.maintain();
    expect(s.metrics().records).toBe(count);
    expect(s.restore(first.id).length).toBeGreaterThan(0);
    expect(s.metrics().pressure).toBe('wal_checkpoint_blocked');
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
  }
  await s.maintain();
  expect(s.metrics().pressure).toBe(null);
  expect(s.integrity().mismatches).toBe(0);
});
test('GC during async preparation cannot leave dangling CAS references', async () => {
  const s = store({ maxAgeDays: 1 });
  const report = {
    request: {
      body: {
        messages: Array.from({ length: 300 }, (_, i) => ({
          role: 'user',
          content: 'shared-' + i + ' 😀 '.repeat(60),
        })),
      },
    },
  };
  await s.ingest(encoded(envelope(report)), { receivedAt: Date.now() - 2 * 86400000 });
  const fresh = s.ingest(encoded(envelope(report)));
  await s.maintain();
  const result = await fresh;
  expect(s.restore(result.id).length).toBeGreaterThan(0);
  expect(s.integrity().mismatches).toBe(0);
});
test('unbounded metadata cannot bypass quota while received fields remain intact', async () => {
  const s = store();
  const report = {
    requestId: 'r'.repeat(30000),
    user: { username: 'u'.repeat(30000) },
    token: { name: 't'.repeat(30000) },
    usage: { promptTokens: 5, unexpected: 'x'.repeat(100000) },
    cost: { usd: 0.01, arbitrary: 'y'.repeat(100000) },
  };
  const body = encoded(envelope(report));
  const result = await s.ingest(body);
  const detail = s.detail(result.id);
  expect(detail.meta.host_request_id.length).toBe(512);
  expect(detail.meta.user_label.length).toBe(256);
  expect(detail.meta.usage_json).toBe('{"promptTokens":5}');
  expect(detail.received_json).toBe(body.toString());
});
