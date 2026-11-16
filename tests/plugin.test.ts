import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { hash } from '../src/server/codec';

const code =
  readFileSync(new URL('../plugins/new-api-report.js', import.meta.url), 'utf8').replaceAll(
    'export ',
    '',
  ) + '\nreport(ctx, record);';
test('public plugin negotiates safe envelope with one manifest and onlymissing objects', () => {
  const calls: string[] = [],
    pieces = new Map<string, string>();
  let manifest: any;
  const record = {
    requestId: 'synthetic',
    request: {
      body: {
        input: [
          {
            role: 'user',
            content: '中文 😀'.repeat(1000),
            encrypted_content: 'omit-synthetic-cipher',
          },
        ],
      },
    },
    response: { truncated: true, stream: false, body: { text: 'visible' } },
  };
  const original = JSON.stringify(record);
  runInNewContext(code, {
    TextEncoder,
    ctx: {
      format: 'openai',
      model: 'synthetic',
      config: { url: 'http://local/api/ingest', source: 'synthetic', token: 'synthetic-secret' },
      headers: { authorization: 'must-not-upload' },
    },
    record,
    utils: {
      uuid: () => crypto.randomUUID(),
      sha256: hash,
      fetch: (request: any) => {
        calls.push(request.body);
        expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(1048576);
        const body = JSON.parse(request.body);
        if (body.op === 'manifest') manifest = body;
        else for (const piece of body.objects) pieces.set(piece.hash, piece.data);
        const refs = [
          ...new Set(manifest.recipe.filter((p: any) => p[0] === 'r').map((p: any) => p[1])),
        ];
        const missing = refs.flatMap((h, i) => (pieces.has(h as string) ? [] : [i]));
        return {
          status: missing.length ? 202 : 200,
          body: {
            wire_version: 2,
            upload_id: manifest.upload_id,
            state: missing.length ? 'partial' : 'complete',
            missing,
            missing_count: missing.length,
            envelope_hash: manifest.envelope_hash,
          },
        };
      },
    },
  });
  expect(calls.length).toBe(2);
  expect(JSON.stringify(record)).toBe(original);
  const json = manifest.recipe.map((p: any) => (p[0] === 'l' ? p[1] : pieces.get(p[1]))).join('');
  const envelope = JSON.parse(json);
  expect(envelope.capture.profile).toBe('readable-v1');
  expect(envelope.report.response.truncated).toBe(true);
  expect(envelope.context.config).toBeUndefined();
  expect(envelope.context.headers).toBeUndefined();
  expect(json).not.toContain('synthetic-secret');
  expect(json).not.toContain('omit-synthetic-cipher');
  expect(hash(json)).toBe(manifest.envelope_hash);
});
test('public plugin finitebudget leaves explicitpartial, fits allPOSTs and prioritizesresponse', () => {
  const calls: any[] = [];
  let manifest: any;
  const sent: string[] = [];
  const record = {
    request: {
      body: {
        input: Array.from({ length: 2500 }, (_, i) => ({
          role: 'user',
          content: ('shared ' + i + ' ').repeat(160),
        })),
      },
    },
    response: { stream: false, body: { text: 'UNIQUE_RESPONSE_'.repeat(150) } },
  };
  runInNewContext(code, {
    TextEncoder,
    ctx: {
      format: 'openai',
      config: { url: 'http://local', source: 'synthetic', token: 'synthetic' },
    },
    record,
    utils: {
      uuid: () => crypto.randomUUID(),
      sha256: hash,
      fetch: (request: any) => {
        calls.push(request);
        expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(1048576);
        const body = JSON.parse(request.body);
        if (body.op === 'manifest') manifest = body;
        else sent.push(...body.objects.map((p: any) => p.data));
        const unique = [
          ...new Set(manifest.recipe.filter((p: any) => p[0] === 'r').map((p: any) => p[1])),
        ];
        const missing = [
          ...manifest.priority,
          ...unique.map((_, i) => i).filter((i) => !manifest.priority.includes(i)),
        ];
        return {
          status: 202,
          body: {
            wire_version: 2,
            upload_id: manifest.upload_id,
            state: 'partial',
            missing,
            missing_count: missing.length,
          },
        };
      },
    },
  });
  expect(calls.length).toBe(4);
  expect(sent[0]).toContain('UNIQUE_RESPONSE_');
});
test('public plugin rejects failure/invalidack and percallbudget before fetch', () => {
  const sandbox: any = {
    TextEncoder,
    ctx: { config: { url: 'http://local', source: 'synthetic', token: 'synthetic' } },
    record: { request: { body: 'fits' } },
    utils: { uuid: () => crypto.randomUUID(), sha256: hash, fetch: () => ({ status: 507 }) },
  };
  expect(() => runInNewContext(code, sandbox)).toThrow('contextledger_upload_failed');
  sandbox.utils.fetch = () => ({ status: 200, body: { state: 'complete' } });
  expect(() => runInNewContext(code, sandbox)).toThrow('contextledger_invalid_ack');
  let nested: any = {};
  sandbox.record = nested;
  for (let i = 0; i < 100; i++) nested = nested.next = {};
  sandbox.utils.fetch = () => {
    throw new Error('unexpected-fetch');
  };
  expect(() => runInNewContext(code, sandbox)).toThrow('contextledger_profile_budget');
});
