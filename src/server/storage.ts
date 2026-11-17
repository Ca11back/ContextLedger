import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type Envelope, metadata, object, type RecordMeta } from '../contracts';
import { decodeParts, hash, type Prepared, prepare, verify } from './codec';
import type { Config } from './config';
import { LedgerError } from './errors';
import { backfillConversations, ConversationIndex, installConversationSchema } from './linking';
import { normalizeEnvelope } from './normalize';

interface Root extends RecordMeta {
  payload: Uint8Array;
}
interface ObjectRow {
  hash: string;
  length: number;
  codec: string;
  compressed: Uint8Array;
  refcount: number;
}
export interface Metrics {
  allocated: number;
  db: number;
  wal: number;
  shm: number;
  live: number;
  reusable: number;
  logical: number;
  records: number;
  objects: number;
  max: number;
  pressure: string | null;
}
export class Ledger {
  readonly db: Database;
  readonly conversations: ConversationIndex;
  private maintenanceRunning = false;
  private owner = crypto.randomUUID();
  private pressure: string | null = null;
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly config: Config) {
    if (config.database !== ':memory:')
      mkdirSync(dirname(resolve(config.database)), { recursive: true, mode: 0o700 });
    const fresh = config.database === ':memory:' || !existsSync(config.database);
    this.db = new Database(config.database, { create: true, strict: true });
    if (fresh) this.db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    if (
      Number((this.db.query('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum) !==
      2
    )
      throw new Error('Database requires auto_vacuum=INCREMENTAL; migrate offline');
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=1048576',
    );
    if (
      config.database !== ':memory:' &&
      (this.db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode !==
        'wal'
    )
      throw new Error('Database requires WAL mode');
    const version = (this.db.query('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== 0 && version !== 2 && version !== 3 && version !== 4)
      throw new Error('Unsupported database format');
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, source TEXT NOT NULL, upload_id TEXT NOT NULL,
      host_request_id TEXT NOT NULL, model TEXT NOT NULL, channel TEXT NOT NULL, user_label TEXT NOT NULL, token_label TEXT NOT NULL,
      outcome TEXT NOT NULL, truncated INTEGER NOT NULL, media INTEGER NOT NULL, duration_ms REAL,
      usage_json TEXT NOT NULL, cost_json TEXT NOT NULL, body_hash TEXT NOT NULL, body_length INTEGER NOT NULL, wire_manifest_hash TEXT,
      storage_mode TEXT NOT NULL CHECK(storage_mode IN ('item_cas','whole_zstd')), payload BLOB NOT NULL,
      UNIQUE(source, upload_id));
      CREATE INDEX IF NOT EXISTS requests_time ON requests(received_at,id);
      CREATE INDEX IF NOT EXISTS requests_host ON requests(host_request_id,id);
      CREATE INDEX IF NOT EXISTS requests_model ON requests(model,id);
      CREATE INDEX IF NOT EXISTS requests_channel ON requests(channel,id);
      CREATE INDEX IF NOT EXISTS requests_user ON requests(user_label,id);
      CREATE INDEX IF NOT EXISTS requests_token ON requests(token_label,id);
      CREATE INDEX IF NOT EXISTS requests_flags ON requests(outcome,truncated,media,id);
      CREATE TABLE IF NOT EXISTS objects(hash TEXT PRIMARY KEY, length INTEGER NOT NULL, codec TEXT NOT NULL DEFAULT 'zstd-v1', compressed BLOB NOT NULL, refcount INTEGER NOT NULL CHECK(refcount>=0));
      CREATE TABLE IF NOT EXISTS maintenance_lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(upload_id TEXT PRIMARY KEY, source TEXT NOT NULL, manifest_hash TEXT NOT NULL, manifest TEXT,
        envelope_hash TEXT NOT NULL, envelope_bytes INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'awaiting_objects',
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, record_id INTEGER, completed_by_upload_id TEXT, hint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS uploads_state_time ON uploads(state,created_at);
      CREATE TABLE IF NOT EXISTS pending_pins(upload_id TEXT NOT NULL REFERENCES uploads(upload_id) ON DELETE CASCADE, hash TEXT NOT NULL, length INTEGER NOT NULL, idx INTEGER NOT NULL, priority INTEGER NOT NULL, PRIMARY KEY(upload_id,hash));
      CREATE INDEX IF NOT EXISTS pending_pins_hash ON pending_pins(hash);
      `);
    try {
      if (version === 2 || version === 3) backfillConversations(this.db, (id) => this.restore(id));
      else if (version === 0)
        this.transaction(() => {
          installConversationSchema(this.db);
          this.db.exec('PRAGMA user_version=4');
        });
      this.conversations = new ConversationIndex(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  metrics(): Metrics {
    const scalar = (sql: string) =>
      Number(Object.values(this.db.query(sql).get() as Record<string, number>)[0]);
    const page = scalar('PRAGMA page_size'),
      pages = scalar('PRAGMA page_count'),
      free = scalar('PRAGMA freelist_count');
    const size = (suffix: string) => {
      try {
        return statSync(this.config.database + suffix).size;
      } catch {
        return 0;
      }
    };
    const db = this.config.database === ':memory:' ? pages * page : size(''),
      wal = size('-wal'),
      shm = size('-shm');
    return {
      allocated: db + wal + shm,
      db,
      wal,
      shm,
      live: (pages - free) * page,
      reusable: free * page,
      logical:
        scalar(
          "SELECT coalesce(sum(length(payload)+length(usage_json)+length(cost_json)+length(CAST(coalesce(response_id,'') AS BLOB))+length(CAST(coalesce(user_id,'') AS BLOB))+length(CAST(coalesce(token_id,'') AS BLOB))+length(CAST(protocol AS BLOB))+length(CAST(last_user_text AS BLOB))+length(CAST(coalesce(previous_response_id,'') AS BLOB))+2048),0) FROM requests",
        ) +
        scalar('SELECT coalesce(sum(length(compressed)+128),0) FROM objects') +
        scalar(
          "SELECT coalesce(sum(length(CAST(title AS BLOB))+length(CAST(models AS BLOB))+length(CAST(coalesce(user_id,'') AS BLOB))+length(CAST(coalesce(token_id,'') AS BLOB))+length(CAST(protocol AS BLOB))+1024),0) FROM conversations",
        ) +
        scalar(
          'SELECT coalesce(sum(length(CAST(user_id AS BLOB))+length(CAST(token_id AS BLOB))+length(CAST(protocol AS BLOB))+1024),0) FROM threads',
        ) +
        scalar('SELECT coalesce(sum(length(model)+128),0) FROM conversation_models'),
      records: scalar('SELECT count(*) FROM requests'),
      objects: scalar('SELECT count(*) FROM objects'),
      max: this.config.maxStorageBytes,
      pressure: this.pressure,
    };
  }
  async ingest(bytes: Uint8Array, options: InsertOptions = {}) {
    if (this.pending >= 4) throw new LedgerError(503, 'ingestion_busy');
    this.pending++;
    // Bound preparation memory and serialize admission; SQLite commit is synchronous.
    const operation = this.queue.then(() => this.insert(bytes, options));
    this.queue = operation.catch(() => undefined);
    try {
      return await operation;
    } finally {
      this.pending--;
    }
  }
  private async insert(bytes: Uint8Array, options: InsertOptions) {
    if (bytes.length > (options.prepared ? 32 * 1024 * 1024 : this.config.maxBodyBytes))
      throw new LedgerError(413, 'body_too_large');
    let envelope: Envelope;
    try {
      const parsed = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (
        parsed.version !== 1 ||
        typeof parsed.upload_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          parsed.upload_id,
        ) ||
        parsed.source !== this.config.source ||
        !parsed.report ||
        Array.isArray(parsed.report) ||
        typeof parsed.report !== 'object' ||
        !parsed.context ||
        Array.isArray(parsed.context) ||
        typeof parsed.context !== 'object'
      )
        throw new Error();
      const allowed = new Set([
        'format',
        'path',
        'model',
        'upstreamModel',
        'group',
        'channel',
        'attempt',
        'instance',
      ]);
      if (Object.keys(object(parsed.context)).some((key) => !allowed.has(key))) throw new Error();
      envelope = parsed as unknown as Envelope;
    } catch {
      throw new LedgerError(400, 'invalid_envelope');
    }
    const bodyHash = hash(bytes);
    const duplicate = this.db
      .query<Root, [string, string]>('SELECT * FROM requests WHERE source=? AND upload_id=?')
      .get(envelope.source, envelope.upload_id);
    if (duplicate) {
      if (duplicate.body_hash !== bodyHash) throw new LedgerError(409, 'upload_id_conflict');
      return { id: duplicate.id, duplicate: true, hash: bodyHash };
    }
    const prepared = options.prepared ?? (await prepare(bytes, options.forceWhole));
    const meta = metadata(envelope);
    const normalized = normalizeEnvelope(envelope);
    // Conservative B-tree/WAL expansion reserve; reject an inadmissible single record before deleting history.
    const baseCost =
      prepared.payload.length +
      16_384 +
      Buffer.byteLength(normalized.responseId ?? '') +
      Buffer.byteLength(normalized.previousResponseId ?? '') +
      3 *
        (Buffer.byteLength(normalized.userId ?? '') +
          Buffer.byteLength(normalized.tokenId ?? '') +
          Buffer.byteLength(normalized.protocol)) +
      Buffer.byteLength(meta.model);
    const cost =
      baseCost +
      [...prepared.objects.values()].reduce(
        (n, o) =>
          n +
          (this.db.query('SELECT 1 FROM objects WHERE hash=?').get(o.hash)
            ? 0
            : o.compressed.length + 256),
        0,
      );
    if (cost * 3 + this.config.reserveBytes > this.config.maxStorageBytes * 0.8)
      throw new LedgerError(507, 'record_exceeds_storage_budget');
    await this.maintain(cost * 3);
    // Check shared bytes before taking the write lock. This synchronous snapshot
    // is revalidated in the commit; complete prepared bytes cover GC removals.
    const verified = new Map<string, ObjectRow>();
    for (const item of prepared.objects.values()) {
      const current = this.db
        .query<ObjectRow, [string]>('SELECT * FROM objects WHERE hash=?')
        .get(item.hash);
      if (current) {
        if (
          current.length !== item.length ||
          current.codec !== 'zstd-v1' ||
          (current.refcount < 1 &&
            !this.db.query('SELECT 1 FROM pending_pins WHERE hash=?').get(item.hash))
        )
          throw new LedgerError(500, 'object_integrity_error');
        try {
          verify(Bun.zstdDecompressSync(current.compressed), item.hash, item.length);
        } catch {
          throw new LedgerError(500, 'object_integrity_error');
        }
        verified.set(item.hash, current);
      }
    }
    const indexMeta = {
      ...meta,
      source: envelope.source,
      received_at: options.receivedAt ?? options.now?.() ?? Date.now(),
    };
    const conversationPrepared = this.conversations.prepare(normalized, indexMeta);
    return this.transaction(() => {
      const committedAt = options.now?.() ?? Date.now();
      const existing = this.db
        .query<Root, [string, string]>('SELECT * FROM requests WHERE source=? AND upload_id=?')
        .get(envelope.source, envelope.upload_id);
      if (existing) {
        if (existing.body_hash !== bodyHash) throw new LedgerError(409, 'upload_id_conflict');
        return { id: existing.id, duplicate: true, hash: bodyHash };
      }
      const currentObjects = new Map<string, ObjectRow>();
      let commitCost = baseCost;
      for (const item of prepared.objects.values()) {
        const current = this.db
          .query<ObjectRow, [string]>('SELECT * FROM objects WHERE hash=?')
          .get(item.hash);
        if (current) {
          const checked = verified.get(item.hash);
          if (
            !checked ||
            current.length !== checked.length ||
            current.codec !== checked.codec ||
            !Buffer.from(current.compressed).equals(checked.compressed)
          )
            throw new LedgerError(503, 'object_changed_during_preparation');
          if (
            current.refcount < 1 &&
            !this.db.query('SELECT 1 FROM pending_pins WHERE hash=?').get(item.hash)
          )
            throw new LedgerError(500, 'object_integrity_error');
          currentObjects.set(item.hash, current);
        } else commitCost += item.compressed.length + 256;
      }
      const m = this.metrics();
      // Reusable pages can fund DB growth; WAL still needs separately reserved physical space.
      const projected =
        m.allocated +
        Math.max(0, commitCost - m.reusable) +
        commitCost * 2 +
        this.config.reserveBytes;
      if (this.pressure || projected > this.config.maxStorageBytes)
        throw new LedgerError(507, 'storage_pressure');
      for (const item of prepared.objects.values()) {
        // Prepared objects are complete regardless of concurrent GC; never depend on earlier presence checks.
        const current = currentObjects.get(item.hash);
        if (current)
          this.db.query('UPDATE objects SET refcount=refcount+1 WHERE hash=?').run(item.hash);
        else
          this.db
            .query('INSERT INTO objects(hash,length,compressed,refcount) VALUES(?,?,?,1)')
            .run(item.hash, item.length, item.compressed);
      }
      const result = this.db
        .query(
          `INSERT INTO requests(received_at,source,upload_id,host_request_id,model,channel,user_label,token_label,outcome,truncated,media,duration_ms,usage_json,cost_json,body_hash,body_length,storage_mode,payload,wire_manifest_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          options.receivedAt ?? committedAt,
          envelope.source,
          envelope.upload_id,
          meta.host_request_id,
          meta.model,
          meta.channel,
          meta.user_label,
          meta.token_label,
          meta.outcome,
          meta.truncated,
          meta.media,
          meta.duration_ms,
          meta.usage_json,
          meta.cost_json,
          bodyHash,
          bytes.length,
          prepared.mode,
          prepared.payload,
          options.manifestHash ?? null,
        );
      const id = Number(result.lastInsertRowid);
      this.conversations.insert(
        id,
        { ...indexMeta, received_at: options.receivedAt ?? committedAt },
        conversationPrepared,
      );
      if (options.finalizeUpload) {
        const changed = this.db
          .query(
            "UPDATE uploads SET state='complete',reason='verified_assembled',record_id=?,completed_at=?,updated_at=?,completed_by_upload_id=?,manifest=NULL WHERE upload_id=? AND state='partial' AND expires_at>?",
          )
          .run(
            id,
            committedAt,
            committedAt,
            options.completedBy ?? null,
            options.finalizeUpload,
            committedAt,
          );
        if (changed.changes !== 1) throw new LedgerError(410, 'upload_expired');
        this.db.query('DELETE FROM pending_pins WHERE upload_id=?').run(options.finalizeUpload);
      }
      return { id, duplicate: false, hash: bodyHash };
    });
  }
  restore(id: number, checkDerivedRefcounts = true): Uint8Array {
    const root = this.db.query<Root, [number]>('SELECT * FROM requests WHERE id=?').get(id);
    if (!root) throw new LedgerError(404, 'record_not_found');
    try {
      const bytes =
        root.storage_mode === 'whole_zstd'
          ? Bun.zstdDecompressSync(root.payload)
          : Buffer.concat(
              decodeParts(root.payload).map((part) => {
                if ('literal' in part) return Buffer.from(part.literal);
                const item = this.db
                  .query<ObjectRow, [string]>('SELECT * FROM objects WHERE hash=?')
                  .get(part.hash);
                if (!item || (checkDerivedRefcounts && item.refcount < 1))
                  throw new LedgerError(500, 'missing_object');
                const restored = Bun.zstdDecompressSync(item.compressed);
                verify(restored, part.hash, item.length);
                return restored;
              }),
            );
      verify(bytes, root.body_hash, root.body_length);
      return bytes;
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new LedgerError(500, 'stored_content_integrity_error');
    }
  }
  detail(id: number) {
    const meta = this.db
      .query<RecordMeta, [number]>(`SELECT ${metaColumns} FROM requests WHERE id=?`)
      .get(id);
    if (!meta) throw new LedgerError(404, 'record_not_found');
    return { meta, received_json: new TextDecoder().decode(this.restore(id)) };
  }
  list(params: URLSearchParams) {
    const where: string[] = [],
      args: (string | number)[] = [];
    const allowed: Record<string, string> = {
      request: 'host_request_id',
      model: 'model',
      channel: 'channel',
      user: 'user_label',
      token: 'token_label',
      outcome: 'outcome',
      truncated: 'truncated',
      media: 'media',
    };
    for (const [key, column] of Object.entries(allowed))
      if (params.get(key)) {
        where.push(`${column}=?`);
        args.push(params.get(key)!);
      }
    for (const [key, comparison] of [
      ['from', '>='],
      ['to', '<='],
      ['cursor', '<'],
    ] as const) {
      const value = params.get(key);
      if (!value) continue;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new LedgerError(400, 'invalid_filter');
      where.push(`${key === 'cursor' ? 'id' : 'received_at'}${comparison}?`);
      args.push(Number(value));
    }
    const requestedLimit = Number(params.get('limit') ?? 25);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
      throw new LedgerError(400, 'invalid_limit');
    const limit = Math.min(50, requestedLimit);
    const rows = this.db
      .query<RecordMeta, (string | number)[]>(
        `SELECT ${metaColumns} FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit + 1);
    const more = rows.length > limit;
    if (more) rows.pop();
    return { rows, cursor: more ? rows.at(-1)!.id : null };
  }
  private deleteRoot(id: number) {
    const root = this.db.query<Root, [number]>('SELECT * FROM requests WHERE id=?').get(id);
    if (!root) return;
    const refs =
      root.storage_mode === 'item_cas'
        ? new Set(decodeParts(root.payload).flatMap((p) => ('hash' in p ? [p.hash] : [])))
        : new Set<string>();
    for (const ref of refs) {
      const changed = this.db
        .query('UPDATE objects SET refcount=refcount-1 WHERE hash=? AND refcount>0')
        .run(ref);
      if (changed.changes !== 1) throw new LedgerError(500, 'refcount_integrity_error');
    }
    this.conversations.remove(id);
    this.db.query('DELETE FROM requests WHERE id=?').run(id);
    this.db
      .query(
        'DELETE FROM objects WHERE refcount=0 AND NOT EXISTS(SELECT 1 FROM pending_pins WHERE pending_pins.hash=objects.hash)',
      )
      .run();
  }
  private checkpoint(): boolean {
    // A reader can prevent WAL reset even after all frames were copied. Inspect
    // SQLite's result instead of inferring progress from a byte threshold, and
    // never block the application event loop waiting for that reader.
    this.db.exec('PRAGMA busy_timeout=0');
    try {
      return (
        this.db.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy === 0
      );
    } finally {
      this.db.exec('PRAGMA busy_timeout=2000');
    }
  }
  async maintain(incoming = 0, now = Date.now()) {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    let epoch = 0;
    try {
      const lease = this.transaction(() => {
        this.db
          .query(
            `INSERT INTO maintenance_lease VALUES(1,?,1,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=maintenance_lease.epoch+1,expires=excluded.expires WHERE maintenance_lease.expires<? OR maintenance_lease.owner=?`,
          )
          .run(this.owner, now + 10_000, now, this.owner);
        return this.db
          .query<{ owner: string; epoch: number }, []>(
            'SELECT owner,epoch FROM maintenance_lease WHERE id=1',
          )
          .get();
      });
      if (lease?.owner !== this.owner) return;
      epoch = lease.epoch;
      this.pressure = null;
      if (!this.checkpoint()) {
        this.pressure = 'wal_checkpoint_blocked';
        return;
      }
      this.db.exec('PRAGMA incremental_vacuum(64)');
      if (!this.checkpoint()) {
        this.pressure = 'wal_checkpoint_blocked';
        return;
      }
      let previous = this.metrics();
      // A pinned WAL must not cause root deletion in pursuit of unavailable reclamation.
      if (previous.wal > this.config.reserveBytes) {
        this.pressure = 'wal_checkpoint_blocked';
        return;
      }
      const triggered =
        previous.allocated + incoming + this.config.reserveBytes >
        this.config.maxStorageBytes * 0.9;
      const pageSize = (this.db.query('PRAGMA page_size').get() as { page_size: number }).page_size;
      let stalled = 0;
      for (let batch = 0; batch < 8; batch++) {
        const m = this.metrics();
        const pressure =
          triggered &&
          m.allocated + incoming + this.config.reserveBytes > this.config.maxStorageBytes * 0.8;
        const cutoff = this.config.maxAgeDays ? now - this.config.maxAgeDays * 86_400_000 : null;
        const ids = this.db
          .query<{ id: number }, (number | null)[]>(
            `SELECT id FROM requests ${pressure ? '' : 'WHERE received_at<?'} ORDER BY received_at,id LIMIT 8`,
          )
          .all(...(pressure ? [] : [cutoff ?? -1]));
        if (!ids.length) {
          this.transaction(() => this.conversations.cleanupThreads());
          break;
        }
        this.transaction(() => {
          const leaseCheck = this.db
            .query(
              'UPDATE maintenance_lease SET expires=? WHERE id=1 AND owner=? AND epoch=? AND expires>=?',
            )
            .run(Date.now() + 10_000, this.owner, epoch, Date.now());
          if (leaseCheck.changes !== 1) throw new LedgerError(503, 'maintenance_lease_lost');
          for (const item of ids) this.deleteRoot(item.id);
          this.conversations.cleanupThreads();
        });
        this.db.exec('PRAGMA incremental_vacuum(64)');
        if (!this.checkpoint()) {
          this.pressure = 'wal_checkpoint_blocked';
          break;
        }
        const after = this.metrics();
        if (after.wal > this.config.reserveBytes) {
          this.pressure = 'wal_checkpoint_blocked';
          break;
        }
        // Logical metadata always shrinks when a root disappears; that does not
        // prove a single storage page became reclaimable or reusable.
        const progress = Math.max(
          previous.allocated - after.allocated,
          previous.live - after.live,
          after.reusable - previous.reusable,
        );
        if (progress < pageSize) stalled++;
        else stalled = 0;
        previous = after;
        if (stalled >= 3) {
          this.pressure = 'maintenance_no_progress';
          break;
        }
        await Bun.sleep(0);
      }
      const final = this.metrics();
      if (final.allocated + incoming + this.config.reserveBytes > this.config.maxStorageBytes)
        this.pressure ??= 'maintenance_work_limit';
    } finally {
      if (epoch)
        this.db
          .query('UPDATE maintenance_lease SET expires=0 WHERE id=1 AND owner=? AND epoch=?')
          .run(this.owner, epoch);
      this.maintenanceRunning = false;
    }
  }
  integrity(rebuild = false) {
    const check = () => {
      const expected = new Map<string, number>();
      for (const root of this.db.query<Root, []>('SELECT * FROM requests').all()) {
        this.restore(root.id, false);
        if (root.storage_mode === 'item_cas')
          for (const ref of new Set(
            decodeParts(root.payload).flatMap((p) => ('hash' in p ? [p.hash] : [])),
          ))
            expected.set(ref, (expected.get(ref) ?? 0) + 1);
      }
      const errors: string[] = [];
      for (const item of this.db.query<ObjectRow, []>('SELECT * FROM objects').all()) {
        verify(Bun.zstdDecompressSync(item.compressed), item.hash, item.length);
        const count = expected.get(item.hash) ?? 0;
        if (item.refcount !== count) {
          errors.push(item.hash);
          if (rebuild)
            this.db.query('UPDATE objects SET refcount=? WHERE hash=?').run(count, item.hash);
        }
      }
      return { checked: this.metrics().records, mismatches: errors.length, rebuilt: rebuild };
    };
    return rebuild ? this.transaction(check) : this.db.transaction(check).deferred();
  }
  rebuildConversations() {
    backfillConversations(this.db, (id) => this.restore(id));
  }
  backup(destination: string) {
    if (existsSync(destination)) throw new Error('Backup destination exists');
    this.db.query('VACUUM INTO ?').run(destination);
  }
  close() {
    this.db.close();
  }
}
interface InsertOptions {
  forceWhole?: boolean;
  receivedAt?: number;
  prepared?: Prepared;
  manifestHash?: string;
  finalizeUpload?: string;
  completedBy?: string;
  now?: () => number;
}
const metaColumns =
  'id,received_at,source,upload_id,host_request_id,model,channel,user_label,token_label,outcome,truncated,media,duration_ms,usage_json,cost_json,body_hash,body_length,storage_mode';
