import { expect, test } from 'bun:test';
import { assertClientModules } from '../scripts/client-boundary';

test('client audit follows concatenated modules and fails closed on omitted graph nodes', () => {
  expect(
    assertClientModules([
      { name: './src/routes/index.tsx', modules: [{ name: './src/client/queries.ts' }] },
    ]),
  ).toBe(2);
  for (const name of [
    './src/server/config.ts',
    '/project/src/server/storage.ts',
    'external module bun:sqlite',
    './src/credentials.server.ts',
  ]) {
    expect(() =>
      assertClientModules([{ name: './src/routes/index.tsx', modules: [{ name }] }]),
    ).toThrow('Server module');
  }
  expect(() => assertClientModules([{ filteredChildren: 1 }])).toThrow('omitted');
  expect(() =>
    assertClientModules([
      { name: './friendly-alias.ts', identifier: '/project/src/server/config.ts' },
    ]),
  ).toThrow('Server module');
});
