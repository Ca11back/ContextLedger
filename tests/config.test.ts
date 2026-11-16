import { expect, test } from 'bun:test';
import { loadConfig } from '../src/server/config';

const credentials = {
  LEDGER_ADMIN_PASSWORD: 'synthetic-admin-password',
  LEDGER_INGEST_TOKEN: 'synthetic-ingest-token-12345678',
  LEDGER_SOURCE: 'synthetic',
};

test('storage quota converts decimal MB to the existing byte configuration', () => {
  const config = loadConfig({ ...credentials, LEDGER_MAX_STORAGE_MB: '10000' });
  expect(config.maxStorageBytes).toBe(10_000_000_000);
  expect(config.reserveBytes).toBe(8 * 1024 * 1024);
  expect(config.maxBodyBytes).toBe(1024 * 1024);
});

test('small positive MB quotas retain byte-based reserve validation', () => {
  expect(loadConfig({ ...credentials, LEDGER_MAX_STORAGE_MB: '1' }).maxStorageBytes).toBe(
    1_000_000,
  );
  expect(() =>
    loadConfig({
      ...credentials,
      LEDGER_MAX_STORAGE_MB: '1',
      LEDGER_RESERVE_BYTES: '500000',
    }),
  ).toThrow('Storage quota must exceed twice the reserve');
});

test('storage quota requires MB even when the former byte variable is supplied', () => {
  expect(() => loadConfig(credentials)).toThrow('Required configuration: LEDGER_MAX_STORAGE_MB');
  expect(() => loadConfig({ ...credentials, LEDGER_MAX_STORAGE_BYTES: '10000000000' })).toThrow(
    'Required configuration: LEDGER_MAX_STORAGE_MB',
  );
});

test.each([
  '',
  '0',
  '-1',
  '1.5',
  '1.00000000000000001',
  'NaN',
  'Infinity',
  'abc',
  '1e4',
  '0x10',
  ' 10 ',
  '10\n',
])('storage quota rejects invalid decimal MB value %j', (value) => {
  expect(() => loadConfig({ ...credentials, LEDGER_MAX_STORAGE_MB: value })).toThrow(
    'LEDGER_MAX_STORAGE_MB',
  );
});

test('storage quota admits the largest safe whole MB count', () => {
  expect(loadConfig({ ...credentials, LEDGER_MAX_STORAGE_MB: '9007199254' }).maxStorageBytes).toBe(
    9_007_199_254_000_000,
  );
});

test.each(['9007199255', '9007199254740991', '9007199254740992'])(
  'storage quota rejects MB values that cannot convert to safe integer bytes: %s',
  (value) => {
    expect(() => loadConfig({ ...credentials, LEDGER_MAX_STORAGE_MB: value })).toThrow(
      'LEDGER_MAX_STORAGE_MB',
    );
  },
);
