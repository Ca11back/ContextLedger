export interface Config {
  database: string;
  maxStorageBytes: number;
  maxAgeDays?: number;
  maxBodyBytes: number;
  adminUser: string;
  adminPassword: string;
  ingestToken: string;
  source: string;
  reserveBytes: number;
  maintenanceMs: number;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Required configuration: ${key}`);
    return value;
  };
  const integer = (key: string, fallback?: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid positive integer: ${key}`);
    return value;
  };
  if (/\D/.test(required('LEDGER_MAX_STORAGE_MB')))
    throw new Error('Invalid positive decimal integer: LEDGER_MAX_STORAGE_MB');
  const maxStorageBytes = integer('LEDGER_MAX_STORAGE_MB') * 1_000_000;
  if (!Number.isSafeInteger(maxStorageBytes))
    throw new Error('LEDGER_MAX_STORAGE_MB exceeds the safe integer byte limit');
  const maxBodyBytes = integer('LEDGER_MAX_BODY_BYTES', 1024 * 1024);
  const reserveBytes = integer(
    'LEDGER_RESERVE_BYTES',
    Math.max(256 * 1024, Math.min(8 * 1024 * 1024, Math.floor(maxStorageBytes / 10))),
  );
  const config = {
    database: env.LEDGER_DATABASE ?? './data/ledger.sqlite',
    maxStorageBytes,
    maxBodyBytes,
    reserveBytes,
    maxAgeDays: env.LEDGER_MAX_AGE_DAYS ? integer('LEDGER_MAX_AGE_DAYS') : undefined,
    adminUser: env.LEDGER_ADMIN_USER ?? 'admin',
    adminPassword: required('LEDGER_ADMIN_PASSWORD'),
    ingestToken: required('LEDGER_INGEST_TOKEN'),
    source: required('LEDGER_SOURCE'),
    maintenanceMs: integer('LEDGER_MAINTENANCE_MS', 30_000),
  };
  if (
    config.adminPassword.length < 16 ||
    config.ingestToken.length < 24 ||
    config.adminPassword === config.ingestToken
  )
    throw new Error('Use distinct strong administrator and ingestion credentials');
  if (reserveBytes >= maxStorageBytes / 2)
    throw new Error('Storage quota must exceed twice the reserve');
  return config;
}
