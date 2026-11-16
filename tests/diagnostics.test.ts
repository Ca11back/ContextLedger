import { expect, spyOn, test } from 'bun:test';
import { ingestDiagnostic } from '../src/server/diagnostics';
import { LedgerError } from '../src/server/errors';
import { ingestHttp } from '../src/server/http';
import type { Ledger } from '../src/server/storage';
import type { Transport } from '../src/server/transport';

test('diagnostic boundary admits only fixed codes/status and bounded numeric fields', () => {
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    ingestDiagnostic(418, 'token=password prompt=<img>', Number.POSITIVE_INFINITY, -5);
    ingestDiagnostic(200, 'stored', 123.9, 4.9);
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      '{"event":"ingest_outcome","status":500,"code":"internal_error","received_bytes":0,"duration_ms":0}',
      '{"event":"ingest_outcome","status":200,"code":"stored","received_bytes":123,"duration_ms":4}',
    ]);
  } finally {
    log.mockRestore();
  }
});
test('length validation and cross-upload conflicts retain their actual diagnostic statuses', () => {
  const log = spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const status of [400, 409]) ingestDiagnostic(status, 'inconsistent_length', 100, 1);
    expect(log.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual(
      [400, 409].map((status) => ({
        event: 'ingest_outcome',
        status,
        code: 'inconsistent_length',
        received_bytes: 100,
        duration_ms: 1,
      })),
    );
  } finally {
    log.mockRestore();
  }
});
test('ingest success/rejection logs never serialize request content, credentials, headers or exception text', async () => {
  const logs: string[] = [];
  const info = spyOn(console, 'info').mockImplementation((value) => {
    logs.push(String(value));
  });
  const errors = spyOn(console, 'error').mockImplementation((value) => {
    logs.push(String(value));
  });
  const secret = 'SENSITIVE-prompt-image-ciphertext-password-token';
  const store = {
    config: { ingestToken: secret, maxBodyBytes: 1024 },
    ingest: async () => ({ id: 1, hash: 'synthetic', duplicate: false }),
  } as unknown as Ledger;
  const request = (auth = secret) =>
    new Request('http://local/api/ingest', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + auth,
        'content-type': 'application/json',
        'x-secret': secret,
      },
      body: JSON.stringify({ prompt: secret, encrypted_content: secret }),
    });
  const receiver = { receive: async () => ({ state: 'complete' }) } as unknown as Transport;
  const call = (req: Request) => ingestHttp(req, store, receiver);
  try {
    expect((await call(request())).status).toBe(200);
    expect((await call(request('wrong-' + secret))).status).toBe(401);
    receiver.receive = async () => {
      throw new Error(secret);
    };
    expect((await call(request())).status).toBe(500);
    receiver.receive = async () => {
      throw new LedgerError(400, secret);
    };
    expect((await call(request())).status).toBe(400);
    expect(logs.length).toBe(5);
    expect(logs.join('')).not.toContain(secret);
    expect(logs.join('')).not.toContain('encrypted_content');
    expect(logs.join('')).not.toContain('authorization');
    const outcomes = logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === 'ingest_outcome');
    expect(outcomes.map((line) => line.code)).toEqual([
      'stored',
      'ingest_auth_required',
      'internal_error',
      'internal_error',
    ]);
  } finally {
    info.mockRestore();
    errors.mockRestore();
  }
});
