import { Database } from 'bun:sqlite';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const snapshotId = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const automaticName = new RegExp(
  String.raw`^ledger-schema\d+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([0-9a-f]{64})-${snapshotId}\.sqlite$`,
);
const automaticStageName = new RegExp(
  String.raw`^\.contextledger-migration-([0-9a-f]{64})-${snapshotId}\.tmp(?:-journal)?$`,
);
const sidecars = ['-wal', '-shm', '-journal'];

class BackupError extends Error {
  constructor(
    readonly code:
      | 'unsupported_database_format'
      | 'migration_backup_failed'
      | 'backup_destination_exists',
    message: string,
  ) {
    super(message);
  }
}

function unsupportedFormat() {
  return new BackupError('unsupported_database_format', 'Unsupported database format');
}

function destinationExists() {
  return new BackupError('backup_destination_exists', 'Backup destination exists');
}

export function startupFailureCode(error: unknown) {
  // The Ledger runs inside the server bundle, with a separate copy of BackupError.
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'unsupported_database_format' || error.code === 'migration_backup_failed')
      return error.code;
  }
  return 'initialization_failed';
}

export function readDatabaseVersion(db: Database) {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
}

function syncPath(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function automaticDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || (entry.mode & 0o777) !== 0o700)
    throw new Error('Backup directory must allow private read and write access');
  syncPath(dirname(directory));
  return directory;
}

function publishSnapshot(
  source: Database,
  destination: string,
  version: number,
  stagingPrefix = '.contextledger-backup-',
) {
  if (lstatSync(destination, { throwIfNoEntry: false })) throw destinationExists();
  const directory = dirname(destination);
  const temporary = join(directory, `${stagingPrefix}${crypto.randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    closeSync(fd);
    // SQLite accepts an empty, exclusively created file and keeps its private mode.
    source.query('VACUUM INTO ?').run(temporary);
    const copy = new Database(temporary, { readonly: true, strict: true });
    try {
      const journal = copy.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
      const check = copy.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
      if (
        readDatabaseVersion(copy) !== version ||
        journal?.journal_mode !== 'delete' ||
        check.length !== 1 ||
        check[0]?.quick_check !== 'ok'
      )
        throw new Error('Backup verification failed');
    } finally {
      copy.close();
    }
    syncPath(temporary);
    try {
      // A hard link publishes the verified file atomically and refuses an occupied name.
      linkSync(temporary, destination);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw destinationExists();
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  syncPath(directory);
}

export function backupOpenDatabase(source: Database, destination: string, database: string) {
  if (lstatSync(destination, { throwIfNoEntry: false })) throw destinationExists();
  const name = basename(destination);
  const path = join(realpathSync.native(dirname(destination)), name);
  if (automaticName.test(name) || automaticStageName.test(name))
    throw new Error('Reserved backup destination');
  if (database !== ':memory:') {
    const sourcePaths = [
      realpathSync.native(database),
      join(realpathSync.native(dirname(database)), basename(database)),
    ];
    if (sourcePaths.some((file) => sidecars.some((suffix) => path === file + suffix)))
      throw new Error('Reserved backup destination');
  }
  publishSnapshot(source, path, readDatabaseVersion(source));
}

function isOwnedPrivateFile(path: string) {
  const file = lstatSync(path, { throwIfNoEntry: false });
  return file?.isFile() && (file.mode & 0o777) === 0o600 && file.uid === process.getuid?.();
}

function snapshotBeforeMigration(source: Database, database: string, version: number) {
  try {
    const directory = automaticDirectory(join(realpathSync.native(dirname(database)), 'backups'));
    const sourceKey = new Bun.CryptoHasher('sha256')
      .update(realpathSync.native(database))
      .digest('hex');
    // Upgrades run with a single writer. Reclaim private staging files left by an interrupted upgrade.
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (automaticStageName.exec(entry)?.[1] === sourceKey && isOwnedPrivateFile(path))
        rmSync(path, { force: true });
    }
    const time = new Date().toISOString().replaceAll(':', '-');
    const name = `ledger-schema${version}-${time}-${sourceKey}-${crypto.randomUUID()}.sqlite`;
    publishSnapshot(
      source,
      join(directory, name),
      version,
      `.contextledger-migration-${sourceKey}-`,
    );

    // Always retain the snapshot just published, even if the system clock moved backwards.
    const prior = readdirSync(directory)
      .flatMap((entry) => {
        const match = automaticName.exec(entry);
        if (entry === name || match?.[2] !== sourceKey) return [];
        return isOwnedPrivateFile(join(directory, entry)) ? [{ entry, time: match[1]! }] : [];
      })
      .sort((a, b) => b.time.localeCompare(a.time));
    for (const { entry } of prior.slice(1)) rmSync(join(directory, entry), { force: true });
    syncPath(directory);
  } catch {
    throw new BackupError('migration_backup_failed', 'Pre-migration backup failed');
  }
}

export function prepareDatabase(database: string, currentVersion: number) {
  if (database === ':memory:') return 0;
  // Keep the configured path intact so SQLite and the filesystem follow the same symlinks.
  const entry = statSync(database, { throwIfNoEntry: false });
  if ((entry && !entry.isFile()) || (!entry && lstatSync(database, { throwIfNoEntry: false })))
    throw unsupportedFormat();
  if (!entry?.size) {
    if (sidecars.some((suffix) => lstatSync(database + suffix, { throwIfNoEntry: false })))
      throw unsupportedFormat();
    return 0;
  }

  const source = new Database(database, { readonly: true, strict: true });
  try {
    const version = readDatabaseVersion(source);
    if (version !== currentVersion && (version < 2 || version > 6)) throw unsupportedFormat();
    const vacuum = source.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get();
    if (vacuum?.auto_vacuum !== 2)
      throw new Error('Database requires auto_vacuum=INCREMENTAL; migrate offline');
    if (version !== currentVersion) snapshotBeforeMigration(source, database, version);
    return version;
  } finally {
    source.close();
  }
}

function backupDatabase(database: string, target: string) {
  if (database === ':memory:') throw new Error('Backup source must be an on-disk database');
  const sourcePath = realpathSync.native(database);
  const sourceFile = statSync(sourcePath);
  if (!sourceFile.isFile() || !sourceFile.size) throw new Error('Backup source must be a database');

  if (lstatSync(target, { throwIfNoEntry: false })) throw destinationExists();
  const parent = dirname(target);
  if (basename(parent) === 'backups') {
    const databaseDirectory = realpathSync.native(dirname(database));
    if (realpathSync.native(dirname(parent)) === databaseDirectory)
      automaticDirectory(join(databaseDirectory, 'backups'));
  }

  const source = new Database(sourcePath, { readonly: true, strict: true });
  try {
    backupOpenDatabase(source, target, database);
  } finally {
    source.close();
  }
}

export function runBackup(database: string, args: string[]) {
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.error(JSON.stringify({ event: 'backup_failed', code: 'invalid_backup_arguments' }));
    return 1;
  }
  try {
    backupDatabase(database, args[0]);
    console.log(JSON.stringify({ event: 'backup_completed' }));
    return 0;
  } catch (error) {
    const code = error instanceof BackupError ? error.code : 'backup_failed';
    console.error(JSON.stringify({ event: 'backup_failed', code }));
    return 1;
  }
}
