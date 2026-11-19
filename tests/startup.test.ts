import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../package.json';

const env = {
  LEDGER_HOST: '127.0.0.1',
  PORT: '0',
  LEDGER_ADMIN_PASSWORD: 'synthetic-admin-password',
  LEDGER_INGEST_TOKEN: 'synthetic-ingest-token-12345678',
  LEDGER_MAX_STORAGE_MB: '64',
  LEDGER_SOURCE: 'synthetic',
};

test('public health response uses the packaged version and requires an open ledger', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-healthz-'));
  const database = join(directory, 'ledger.sqlite');
  try {
    const route = new URL('../src/routes/healthz.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        `import { Route } from ${JSON.stringify(route)};
         const response = Route.options.server.handlers.GET();
         console.log(JSON.stringify({ status: response.status, body: await response.json() }));`,
      ],
      {
        env: { ...env, LEDGER_DATABASE: database, npm_package_version: '9.9.9' },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 200,
      body: { status: 'ok', service: 'contextledger', version, wire: [2] },
    });
    expect(existsSync(database)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standalone bootstrap exits before listening if the database cannot open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-startup-'));
  try {
    // Point the standalone wrapper at the real application source without requiring a build.
    const entry = new URL('../src/server.ts', import.meta.url).href;
    const dist = join(directory, 'dist/server');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), `export { default } from ${JSON.stringify(entry)};`);
    copyFileSync(new URL('../server.ts', import.meta.url), join(directory, 'server.ts'));
    const file = join(directory, 'synthetic-private-path');
    writeFileSync(file, 'plain file');
    const result = spawnSync(process.execPath, ['--no-env-file', 'run', 'server.ts'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...env, LEDGER_DATABASE: join(file, 'ledger.sqlite') },
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('{"event":"startup_failed","code":"initialization_failed"}');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
