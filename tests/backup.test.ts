import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupFailureCode } from '../src/server/backup';
import type { Config } from '../src/server/config';
import { SCHEMA_VERSION } from '../src/server/linking';
import { Ledger } from '../src/server/storage';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-backup-'));
  directories.push(directory);
  const config: Config = {
    database: join(directory, 'ledger.sqlite'),
    maxStorageBytes: 64_000_000,
    maxBodyBytes: 1_048_576,
    adminUser: 'admin',
    adminPassword: 'synthetic-admin-password',
    ingestToken: 'synthetic-ingest-token-12345678',
    source: 'synthetic',
    reserveBytes: 262_144,
    maintenanceMs: 30_000,
  };
  return { directory, config, backups: join(directory, 'backups') };
}

function stageRuntime(directory: string) {
  mkdirSync(join(directory, 'src/server'), { recursive: true });
  for (const path of ['server.ts', 'src/server/backup.ts', 'src/server/config.ts'])
    copyFileSync(new URL(`../${path}`, import.meta.url), join(directory, path));
}

function setVersion(config: Config, version: number) {
  const ledger = new Ledger(config);
  try {
    ledger.db.exec(`PRAGMA user_version=${version}`);
  } finally {
    ledger.close();
  }
}

function versionAt(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db.query('PRAGMA user_version').get();
  } finally {
    db.close();
  }
}

function openFailure(config: Config) {
  try {
    new Ledger(config).close();
  } catch (error) {
    return startupFailureCode(error);
  }
  throw new Error('Expected the database to fail to open');
}

test('new, zero-byte and current databases open without automatic snapshots', () => {
  const { config, backups, directory } = fixture();
  setVersion(config, SCHEMA_VERSION);
  new Ledger(config).close();
  const empty = { ...config, database: join(directory, 'empty.sqlite') };
  writeFileSync(empty.database, '');
  new Ledger(empty).close();
  expect(versionAt(empty.database)).toEqual({ user_version: SCHEMA_VERSION });
  expect(existsSync(backups)).toBe(false);
});

test('preflight refuses unversioned, future, and wrong-mode databases before persistent writes', () => {
  const { config, backups, directory } = fixture();
  for (const [version, incremental, code] of [
    [0, true, 'unsupported_database_format'],
    [SCHEMA_VERSION + 1, true, 'unsupported_database_format'],
    [5, false, 'initialization_failed'],
  ] as const) {
    const database = join(directory, `refused-v${version}.sqlite`);
    const original = new Database(database);
    try {
      if (incremental) original.exec('PRAGMA auto_vacuum=INCREMENTAL');
      original.exec(`CREATE TABLE original ( value ); PRAGMA user_version=${version}`);
    } finally {
      original.close();
    }
    const before = readFileSync(database);
    expect(openFailure({ ...config, database })).toBe(code);
    expect(readFileSync(database)).toEqual(before);
    expect(existsSync(backups)).toBe(false);
  }
});

test('pre-migration backup errors leave the old database byte-identical and retryable', () => {
  const { config, backups } = fixture();
  setVersion(config, 5);
  const original = readFileSync(config.database);
  mkdirSync(backups, { mode: 0o500 });
  expect(openFailure(config)).toBe('migration_backup_failed');
  expect(readFileSync(config.database)).toEqual(original);
  expect(readdirSync(backups)).toEqual([]);

  chmodSync(backups, 0o700);
  new Ledger(config).close();
  expect(versionAt(config.database)).toEqual({ user_version: SCHEMA_VERSION });
  const names = readdirSync(backups);
  expect(names).toHaveLength(1);
  const snapshot = join(backups, names[0]!);
  expect(statSync(snapshot).mode & 0o777).toBe(0o600);
  expect(versionAt(snapshot)).toEqual({ user_version: 5 });
});

test('preflight and operator backups follow SQLite paths through symlink parents', () => {
  const { config, directory, backups } = fixture();
  const other = join(directory, 'other');
  mkdirSync(join(other, 'sub'), { recursive: true });
  symlinkSync(join(other, 'sub'), join(directory, 'alias'));
  const actual = join(other, 'ledger.sqlite');
  for (const [database, marker] of [
    [config.database, 'lexical neighbour'],
    [actual, 'configured database'],
  ] as const) {
    const ledger = new Ledger({ ...config, database });
    try {
      ledger.db.exec('CREATE TABLE marker (name TEXT); PRAGMA user_version=5');
      ledger.db.query('INSERT INTO marker VALUES (?)').run(marker);
    } finally {
      ledger.close();
    }
  }
  const database = `${join(directory, 'alias')}/../ledger.sqlite`;
  new Ledger({ ...config, database }).close();
  expect(versionAt(config.database)).toEqual({ user_version: 5 });
  expect(versionAt(actual)).toEqual({ user_version: SCHEMA_VERSION });
  expect(existsSync(backups)).toBe(false);
  const actualBackups = join(other, 'backups');
  const names = readdirSync(actualBackups);
  expect(names).toHaveLength(1);
  const snapshot = join(actualBackups, names[0]!);
  expect(versionAt(snapshot)).toEqual({ user_version: 5 });

  stageRuntime(directory);
  const target = `${join(directory, 'alias')}/../backups/manual.sqlite`;
  const backup = spawnSync(
    process.execPath,
    ['--no-env-file', 'run', 'server.ts', 'backup', target],
    {
      cwd: directory,
      env: { LEDGER_DATABASE: database },
      timeout: 5000,
    },
  );
  expect(backup.status).toBe(0);
  const manual = join(actualBackups, 'manual.sqlite');
  expect(versionAt(manual)).toEqual({ user_version: SCHEMA_VERSION });
  for (const copy of [snapshot, manual]) {
    const db = new Database(copy, { readonly: true });
    try {
      expect(db.query('SELECT name FROM marker').get()).toEqual({ name: 'configured database' });
    } finally {
      db.close();
    }
  }
});

test('retention keeps the latest two automatic snapshots per source across schema versions', () => {
  const { config, backups, directory } = fixture();
  const other = { ...config, database: join(directory, 'other.sqlite') };
  setVersion(other, 6);
  new Ledger(other).close();
  const otherSnapshot = readdirSync(backups)[0]!;
  writeFileSync(join(backups, 'manual.sqlite'), 'manual', { mode: 0o600 });
  const named = (version: number) =>
    readdirSync(backups).find(
      (name) => name !== otherSnapshot && name.startsWith(`ledger-schema${version}-`),
    )!;

  setVersion(config, 6);
  new Ledger(config).close();
  const older = named(6);
  const olderPath = older.replace(/\d{4}-\d{2}-\d{2}T/, '2022-01-01T');
  renameSync(join(backups, older), join(backups, olderPath));
  setVersion(config, 5);
  new Ledger(config).close();
  const newer = named(5);
  const newerPath = newer.replace(/\d{4}-\d{2}-\d{2}T/, '2023-01-01T');
  renameSync(join(backups, newer), join(backups, newerPath));
  setVersion(config, 4);
  new Ledger(config).close();

  expect(readdirSync(backups).sort()).toEqual(
    [named(4), newerPath, otherSnapshot, 'manual.sqlite'].sort(),
  );
  expect(readFileSync(join(backups, 'manual.sqlite'), 'utf8')).toBe('manual');
});

test('an interrupted publisher leaves no completed snapshot and does not migrate', () => {
  const { config, backups } = fixture();
  setVersion(config, 5);
  const original = readFileSync(config.database);
  const result = spawnSync(
    process.execPath,
    [
      '--no-env-file',
      '-e',
      `import { mock } from 'bun:test';
       import * as fs from 'node:fs';
       const { ...actual } = fs;
       mock.module('node:fs', () => ({
         ...actual,
         linkSync: () => process.kill(process.pid, 'SIGKILL'),
       }));
       const { Ledger } = await import(${JSON.stringify(new URL('../src/server/storage.ts', import.meta.url).href)});
       new Ledger(${JSON.stringify(config)});`,
    ],
    { timeout: 5000 },
  );
  expect(result.signal).toBe('SIGKILL');
  expect(readFileSync(config.database)).toEqual(original);
  const interrupted = readdirSync(backups);
  expect(interrupted).toHaveLength(1);
  expect(interrupted[0]).toMatch(/^\.contextledger-migration-.*\.tmp$/);
  const manualStage = join(backups, '.contextledger-backup-manual.tmp');
  writeFileSync(manualStage, 'manual', { mode: 0o600 });

  new Ledger(config).close();
  expect(versionAt(config.database)).toEqual({ user_version: SCHEMA_VERSION });
  expect(existsSync(join(backups, interrupted[0]!))).toBe(false);
  expect(readdirSync(backups).filter((name) => name.endsWith('.sqlite'))).toHaveLength(1);
  expect(readFileSync(manualStage, 'utf8')).toBe('manual');
});

test('the standalone backup command reads a consistent WAL snapshot during concurrent writes', async () => {
  const { directory, config, backups } = fixture();
  stageRuntime(directory);
  const writer = new Database(config.database);
  try {
    writer.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0; PRAGMA user_version=5;
      CREATE TABLE entries (id INTEGER PRIMARY KEY, payload BLOB);
      WITH RECURSIVE ids(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM ids WHERE i<48)
      INSERT INTO entries SELECT i, randomblob(131072) FROM ids;`);
    expect(statSync(`${config.database}-wal`).size).toBeGreaterThan(6_000_000);
    const target = join(backups, 'operator.sqlite');
    const backup = Bun.spawn(
      [process.execPath, '--no-env-file', 'run', 'server.ts', 'backup', target],
      {
        cwd: directory,
        env: { LEDGER_DATABASE: config.database },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
      },
    );
    const insert = writer.query('INSERT INTO entries (payload) VALUES (randomblob(4096))');
    let inserted = 0;
    try {
      while (backup.exitCode === null && inserted < 200) {
        insert.run();
        inserted++;
        await Bun.sleep(1);
      }
      expect(await backup.exited).toBe(0);
    } finally {
      if (backup.exitCode === null) backup.kill();
    }
    expect(inserted).toBeGreaterThan(0);
    expect(await new Response(backup.stdout).json()).toEqual({ event: 'backup_completed' });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(versionAt(config.database)).toEqual({ user_version: 5 });
    expect(versionAt(target)).toEqual({ user_version: 5 });
    const snapshot = new Database(target, { readonly: true });
    try {
      const rows = snapshot
        .query<{ count: number; last: number }, []>(
          'SELECT count(*) AS count, max(id) AS last FROM entries',
        )
        .get()!;
      expect(rows.count).toBe(rows.last);
      expect(rows.count).toBeGreaterThanOrEqual(48);
      expect(rows.count).toBeLessThanOrEqual(48 + inserted);
      expect(snapshot.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    } finally {
      snapshot.close();
    }
    expect(writer.query('SELECT count(*) AS count FROM entries').get()).toEqual({
      count: 48 + inserted,
    });
    expect(readdirSync(backups)).toEqual(['operator.sqlite']);
  } finally {
    writer.close();
  }
}, 10_000);

test('the standalone command uses the default database path and refuses occupied and reserved destinations', () => {
  const { directory, config } = fixture();
  stageRuntime(directory);
  const database = join(directory, 'data', 'ledger.sqlite');
  setVersion({ ...config, database }, SCHEMA_VERSION);
  const offline = new Database(database);
  try {
    offline.exec('PRAGMA journal_mode=DELETE');
  } finally {
    offline.close();
  }
  const target = join(directory, 'manual.sqlite');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--no-env-file', 'run', 'server.ts', 'backup', ...args], {
      cwd: directory,
      env: {},
      encoding: 'utf8',
      timeout: 5000,
    });
  expect(run(target).status).toBe(0);
  const original = readFileSync(target);
  const occupied = run(target);
  expect(occupied.status).toBe(1);
  expect(JSON.parse(occupied.stderr)).toEqual({
    event: 'backup_failed',
    code: 'backup_destination_exists',
  });
  expect(readFileSync(target)).toEqual(original);
  const alias = join(directory, 'db-alias');
  symlinkSync(join(directory, 'data'), alias);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const reserved = run(join(alias, `ledger.sqlite${suffix}`));
    expect(reserved.status).toBe(1);
    expect(JSON.parse(reserved.stderr)).toEqual({ event: 'backup_failed', code: 'backup_failed' });
    expect(existsSync(database + suffix)).toBe(false);
  }
  const autoName = `ledger-schema5-2023-01-01T00-00-00.000Z-${'0'.repeat(64)}-00000000-0000-4000-8000-000000000000.sqlite`;
  expect(run(join(directory, autoName)).status).toBe(1);
  expect(existsSync(join(directory, autoName))).toBe(false);
  expect(JSON.parse(run().stderr)).toEqual({
    event: 'backup_failed',
    code: 'invalid_backup_arguments',
  });
});
