import { object } from '../contracts';
import { decodeParts, hash, type Part, type Prepared, verify } from './codec';
import { LedgerError } from './errors';
import type { Ledger } from './storage';

const WIRE_VERSION = 2;
export const SUPPORTED_WIRE_VERSIONS: readonly number[] = [WIRE_VERSION];

export type Recipe = (['l', string] | ['r', string, number])[];
interface Ref {
  hash: string;
  length: number;
  index: number;
  priority: number;
}
interface Manifest {
  wire_version: typeof WIRE_VERSION;
  op: 'manifest';
  source: string;
  upload_id: string;
  envelope_hash: string;
  envelope_bytes: number;
  recipe: Recipe;
  priority: number[];
  hint: unknown;
}
interface Upload {
  upload_id: string;
  source: string;
  manifest_hash: string;
  manifest: string | null;
  envelope_hash: string;
  envelope_bytes: number;
  state: string;
  reason: string;
  created_at: number;
  expires_at: number;
  updated_at: number;
  completed_at: number | null;
  record_id: number | null;
  completed_by_upload_id: string | null;
  hint: string;
}
interface Chunk {
  hash: string;
  length: number;
  compressed: Uint8Array;
  codec: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const maximum = 32 * 1024 * 1024,
  ttl = 15 * 60_000;
function fail(status: number, code: string): never {
  throw new LedgerError(status, code);
}
function exact(value: unknown, keys: string[]) {
  const o = object(value);
  return Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}
function validString(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function manifestRefs(recipe: Recipe, priority: number[]): Ref[] {
  const unique = new Map<string, Ref>();
  let total = 0;
  if (
    !Array.isArray(recipe) ||
    recipe.length < 1 ||
    recipe.length > 16384 ||
    !Array.isArray(priority)
  )
    fail(400, 'invalid_manifest');
  for (const entry of recipe) {
    if (!Array.isArray(entry)) fail(400, 'invalid_manifest');
    if (entry[0] === 'l' && entry.length === 2 && typeof entry[1] === 'string')
      total += Buffer.byteLength(entry[1]);
    else if (
      entry[0] === 'r' &&
      entry.length === 3 &&
      validString(entry[1], digest) &&
      Number.isSafeInteger(entry[2]) &&
      entry[2] > 0 &&
      entry[2] <= 131072
    ) {
      const old = unique.get(entry[1]);
      if (old && old.length !== entry[2]) fail(400, 'inconsistent_length');
      if (!old)
        unique.set(entry[1], { hash: entry[1], length: entry[2], index: unique.size, priority: 0 });
      total += entry[2];
    } else fail(400, 'invalid_manifest');
    if (total > maximum) fail(413, 'envelope_too_large');
  }
  if (unique.size > 8192) fail(413, 'manifest_too_large');
  const refs = [...unique.values()],
    seen = new Set<number>();
  for (const index of priority) {
    if (!Number.isInteger(index) || index < 0 || index >= refs.length || seen.has(index))
      fail(400, 'invalid_priority');
    seen.add(index);
    refs[index]!.priority = priority.length - seen.size + 1;
  }
  return refs;
}
function manifestLength(recipe: Recipe) {
  return recipe.reduce((n, p) => n + (p[0] === 'l' ? Buffer.byteLength(p[1]) : p[2]), 0);
}
export class Transport {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(
    readonly store: Ledger,
    readonly clock: () => number = Date.now,
  ) {}
  private transaction<T>(fn: () => T) {
    return this.store.db.transaction(fn).immediate();
  }
  private get(id: string) {
    return this.store.db.query<Upload, [string]>('SELECT * FROM uploads WHERE upload_id=?').get(id);
  }
  async receive(bytes: Uint8Array) {
    if (bytes.length > Math.min(1048576, this.store.config.maxBodyBytes))
      fail(413, 'body_too_large');
    if (this.pending >= 4) fail(503, 'ingestion_busy');
    this.pending++;
    const result = this.queue.then(() => this.operation(bytes));
    this.queue = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      this.pending--;
    }
  }
  private async operation(bytes: Uint8Array) {
    let data: Record<string, unknown>;
    try {
      data = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      return fail(400, 'invalid_wire');
    }
    const version = data.wire_version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0)
      fail(400, 'invalid_wire');
    if (!SUPPORTED_WIRE_VERSIONS.includes(version)) fail(400, 'unsupported_wire_version');
    if (data.source !== this.store.config.source || !validString(data.upload_id, uuid))
      fail(400, 'invalid_wire');
    await this.expire();
    const id = data.upload_id;
    if (data.op === 'manifest') await this.manifest(data as unknown as Manifest, bytes);
    else if (data.op === 'objects') await this.objects(data);
    else fail(400, 'invalid_wire');
    const older = this.ready(id, id);
    await this.finalize(id, id);
    if (older) {
      try {
        await this.finalize(older, id);
      } catch (error) {
        if (!(error instanceof LedgerError) || ![400, 500].includes(error.status)) throw error;
      }
    }
    // A just-completed receipt may tie the terminal-history cutoff timestamp.
    // Capture its ACK before bounded UI-history trimming can remove that row.
    const state = this.state(id);
    this.trimTerminal();
    return state;
  }
  private async manifest(m: Manifest, bytes: Uint8Array) {
    if (
      !exact(m, [
        'wire_version',
        'op',
        'source',
        'upload_id',
        'envelope_hash',
        'envelope_bytes',
        'recipe',
        'priority',
        'hint',
      ]) ||
      !validString(m.envelope_hash, digest) ||
      !Number.isSafeInteger(m.envelope_bytes) ||
      m.envelope_bytes < 1
    )
      fail(400, 'invalid_manifest');
    if (m.envelope_bytes > maximum) fail(413, 'envelope_too_large');
    const refs = manifestRefs(m.recipe, m.priority);
    if (manifestLength(m.recipe) !== m.envelope_bytes) fail(400, 'envelope_length_mismatch');
    if (!exact(m.hint, ['request_id', 'context'])) fail(400, 'invalid_hint');
    const hint = object(m.hint),
      context = object(hint.context);
    if (
      !exact(context, ['format', 'model']) ||
      [hint.request_id, context.format, context.model].some(
        (value) => typeof value !== 'string' || value.length > 256,
      )
    )
      fail(400, 'invalid_hint');
    const identity = hash(bytes),
      existing = this.get(m.upload_id);
    const retained = this.store.db
      .query<
        { id: number; received_at: number; body_hash: string; wire_manifest_hash: string | null },
        [string, string]
      >(
        'SELECT id,received_at,body_hash,wire_manifest_hash FROM requests WHERE source=? AND upload_id=?',
      )
      .get(m.source, m.upload_id);
    if (retained) {
      if (retained.wire_manifest_hash !== identity || retained.body_hash !== m.envelope_hash)
        fail(409, 'upload_id_conflict');
      if (!existing)
        this.rehydrate(
          retained.id,
          m.upload_id,
          identity,
          m.envelope_hash,
          m.envelope_bytes,
          JSON.stringify(m.hint),
          retained.received_at,
        );
      return;
    }
    if (existing) {
      if (existing.manifest_hash !== identity) fail(409, 'upload_id_conflict');
      if (existing.state === 'expired' || existing.state === 'failed') fail(410, 'upload_expired');
      return;
    }
    const cost = bytes.length + refs.length * 200 + 8192;
    if (cost * 3 + this.store.config.reserveBytes > this.store.config.maxStorageBytes * 0.8)
      fail(507, 'staging_pressure');
    // Reject impossible staging work before retention can remove any evidence.
    // Recheck inside the commit in case reachability changed while yielding.
    this.checkStaging(refs, bytes.length);
    await this.store.maintain(cost * 3, this.clock());
    this.transaction(() => {
      this.checkStaging(refs, bytes.length);
      this.admit(cost);
      const now = this.clock();
      this.store.db
        .query(
          "INSERT INTO uploads(upload_id,source,manifest_hash,manifest,envelope_hash,envelope_bytes,state,created_at,expires_at,updated_at,hint) VALUES(?,?,?,?,?,?,'partial',?,?,?,?)",
        )
        .run(
          m.upload_id,
          m.source,
          identity,
          Buffer.from(bytes).toString('utf8'),
          m.envelope_hash,
          m.envelope_bytes,
          now,
          now + ttl,
          now,
          JSON.stringify(m.hint),
        );
      const pin = this.store.db.query(
        'INSERT INTO pending_pins(upload_id,hash,length,idx,priority) VALUES(?,?,?,?,?)',
      );
      for (const ref of refs) pin.run(m.upload_id, ref.hash, ref.length, ref.index, ref.priority);
    });
  }
  private checkStaging(refs: Ref[], manifestBytes: number) {
    const active = this.store.db
      .query<{ n: number }, []>("SELECT count(*) n FROM uploads WHERE state='partial'")
      .get()!.n;
    if (active >= 16) fail(507, 'staging_limit');
    const lengths = this.store.db
      .query<{ hash: string; length: number }, []>(
        'SELECT hash,length FROM pending_pins GROUP BY hash',
      )
      .all();
    const unique = new Map(lengths.map((row) => [row.hash, row.length]));
    for (const ref of refs) {
      const old = unique.get(ref.hash);
      if (old !== undefined && old !== ref.length) fail(409, 'inconsistent_length');
      unique.set(ref.hash, ref.length);
      const present = this.store.db
        .query<{ length: number }, [string]>('SELECT length FROM objects WHERE hash=?')
        .get(ref.hash);
      if (present && present.length !== ref.length) fail(409, 'inconsistent_length');
    }
    const manifests = this.store.db
      .query<{ n: number }, []>(
        "SELECT coalesce(sum(length(CAST(manifest AS BLOB))),0) n FROM uploads WHERE state='partial'",
      )
      .get()!.n;
    const reservation =
      [...unique.values()].reduce((n, len) => n + len, 0) + manifests + manifestBytes;
    if (reservation > Math.min(64 * 1024 * 1024, Math.floor(this.store.config.maxStorageBytes / 4)))
      fail(507, 'staging_limit');
  }
  private rehydrate(
    recordId: number,
    id: string,
    identity: string,
    bodyHash: string,
    length: number,
    hint: string,
    completedAt: number,
  ) {
    const now = this.clock();
    this.store.db
      .query(
        "INSERT INTO uploads(upload_id,source,manifest_hash,envelope_hash,envelope_bytes,state,reason,created_at,expires_at,updated_at,completed_at,record_id,hint) VALUES(?,?,?,?,?,'complete','verified_assembled',?,?,?,?,?,?)",
      )
      .run(
        id,
        this.store.config.source,
        identity,
        bodyHash,
        length,
        now,
        now,
        now,
        completedAt,
        recordId,
        hint,
      );
  }
  private admit(cost: number) {
    const m = this.store.metrics();
    if (
      m.pressure ||
      m.allocated + Math.max(0, cost - m.reusable) + cost * 2 + this.store.config.reserveBytes >
        m.max
    )
      fail(507, 'storage_pressure');
  }
  private async objects(data: Record<string, unknown>) {
    if (
      !exact(data, ['wire_version', 'op', 'source', 'upload_id', 'objects']) ||
      !Array.isArray(data.objects) ||
      !data.objects.length ||
      data.objects.length > 8192
    )
      fail(400, 'invalid_objects');
    const id = data.upload_id as string;
    let upload = this.get(id);
    if (!upload) {
      const root = this.store.db
        .query<
          {
            id: number;
            received_at: number;
            body_hash: string;
            body_length: number;
            wire_manifest_hash: string | null;
          },
          [string, string]
        >(
          'SELECT id,received_at,body_hash,body_length,wire_manifest_hash FROM requests WHERE source=? AND upload_id=?',
        )
        .get(this.store.config.source, id);
      if (root?.wire_manifest_hash) {
        this.rehydrate(
          root.id,
          id,
          root.wire_manifest_hash,
          root.body_hash,
          root.body_length,
          '{}',
          root.received_at,
        );
        upload = this.get(id);
      }
    }
    if (!upload) fail(404, 'upload_not_found');
    if (
      upload.state === 'expired' ||
      upload.state === 'failed' ||
      (upload.expires_at <= this.clock() && upload.state !== 'complete')
    )
      fail(410, 'upload_expired');
    // Completed retries still validate against the retained complete recipe.
    const expected = new Map(
      this.store.db
        .query<{ hash: string; length: number }, [string]>(
          'SELECT hash,length FROM pending_pins WHERE upload_id=?',
        )
        .all(id)
        .map((ref) => [ref.hash, ref.length]),
    );
    if (upload.state === 'complete') {
      const root = this.store.db
        .query<{ payload: Uint8Array }, [number]>('SELECT payload FROM requests WHERE id=?')
        .get(upload.record_id!);
      if (!root) fail(410, 'upload_record_evicted');
      for (const part of decodeParts(root.payload))
        if ('hash' in part) {
          const row = this.store.db
            .query<{ length: number }, [string]>('SELECT length FROM objects WHERE hash=?')
            .get(part.hash);
          if (row) expected.set(part.hash, row.length);
        }
    }
    const chunks = new Map<string, Chunk>();
    for (const entry of data.objects) {
      if (
        !exact(entry, ['hash', 'data']) ||
        !validString(entry.hash, digest) ||
        typeof entry.data !== 'string' ||
        Buffer.byteLength(JSON.stringify(entry)) > 131072
      )
        fail(400, 'invalid_object');
      const length = expected.get(entry.hash);
      if (length === undefined) fail(400, 'unrequested_object');
      const body = Buffer.from(entry.data);
      if (body.length !== length || hash(body) !== entry.hash) fail(400, 'object_hash_mismatch');
      if (!chunks.has(entry.hash))
        chunks.set(entry.hash, {
          hash: entry.hash,
          length,
          codec: 'zstd-v1',
          compressed: await Bun.zstdCompress(body),
        });
    }
    if (upload.state === 'complete') return;
    const absent = [...chunks.values()].filter(
      (chunk) => !this.store.db.query('SELECT 1 FROM objects WHERE hash=?').get(chunk.hash),
    );
    const cost = absent.reduce((n, chunk) => n + chunk.compressed.length + 256, 0) + 4096;
    await this.store.maintain(cost * 3, this.clock());
    // Verify immutable existing objects outside the write transaction.
    for (const chunk of chunks.values()) {
      const old = this.store.db
        .query<Chunk, [string]>('SELECT * FROM objects WHERE hash=?')
        .get(chunk.hash);
      if (old) {
        if (old.length !== chunk.length || old.codec !== 'zstd-v1')
          fail(500, 'object_integrity_error');
        verify(await Bun.zstdDecompress(old.compressed), chunk.hash, chunk.length);
      }
    }
    this.transaction(() => {
      if ((this.get(id)?.expires_at ?? 0) <= this.clock()) fail(410, 'upload_expired');
      this.admit(cost);
      let progress = 0;
      for (const chunk of chunks.values()) {
        const result = this.store.db
          .query(
            'INSERT OR IGNORE INTO objects(hash,length,codec,compressed,refcount) VALUES(?,?,?,?,0)',
          )
          .run(chunk.hash, chunk.length, chunk.codec, chunk.compressed);
        progress += result.changes;
      }
      if (progress) {
        const now = this.clock();
        this.store.db
          .query(
            'UPDATE uploads SET expires_at=min(created_at+3600000,?),updated_at=? WHERE upload_id=?',
          )
          .run(now + ttl, now, id);
      }
    });
  }
  private ready(except = '', affectedUpload?: string) {
    const affected = affectedUpload
      ? 'AND EXISTS(SELECT 1 FROM pending_pins affected JOIN pending_pins candidate ON candidate.hash=affected.hash WHERE affected.upload_id=? AND candidate.upload_id=u.upload_id)'
      : '';
    return this.store.db
      .query<{ upload_id: string }, (number | string)[]>(
        `SELECT upload_id FROM uploads u WHERE state='partial' AND expires_at>? AND upload_id<>? ${affected} AND NOT EXISTS(SELECT 1 FROM pending_pins p LEFT JOIN objects o ON o.hash=p.hash WHERE p.upload_id=u.upload_id AND o.hash IS NULL) ORDER BY created_at LIMIT 1`,
      )
      .get(this.clock(), except, ...(affectedUpload ? [affectedUpload] : []))?.upload_id;
  }
  private async finalize(id: string, completedBy: string) {
    const upload = this.get(id);
    if (!upload || upload.state !== 'partial' || upload.expires_at <= this.clock()) return;
    const missing = this.store.db
      .query(
        'SELECT 1 FROM pending_pins p LEFT JOIN objects o ON p.hash=o.hash WHERE p.upload_id=? AND o.hash IS NULL LIMIT 1',
      )
      .get(id);
    if (missing) return;
    try {
      const manifest = JSON.parse(upload.manifest!) as Manifest;
      const chunks = new Map<string, Chunk>();
      const decoded = new Map<string, Buffer>();
      for (const ref of manifestRefs(manifest.recipe, manifest.priority)) {
        const chunk = this.store.db
          .query<Chunk, [string]>('SELECT * FROM objects WHERE hash=?')
          .get(ref.hash);
        if (!chunk) return;
        if (chunk.length !== ref.length || chunk.codec !== 'zstd-v1')
          fail(500, 'object_integrity_error');
        const restored = await Bun.zstdDecompress(chunk.compressed);
        verify(restored, ref.hash, ref.length);
        chunks.set(ref.hash, chunk);
        decoded.set(ref.hash, restored);
      }
      const body = Buffer.concat(
        manifest.recipe.map((part) =>
          part[0] === 'l' ? Buffer.from(part[1]) : decoded.get(part[1])!,
        ),
      );
      verify(body, upload.envelope_hash, upload.envelope_bytes);
      let envelope: Record<string, unknown>;
      try {
        envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
      } catch {
        return fail(400, 'invalid_envelope');
      }
      if (envelope.upload_id !== id || envelope.source !== upload.source)
        fail(400, 'invalid_envelope');
      const parts: Part[] = manifest.recipe.map((part) =>
        part[0] === 'l' ? { literal: part[1] } : { hash: part[1] },
      );
      const prepared: Prepared = {
        mode: 'item_cas',
        hash: upload.envelope_hash,
        length: body.length,
        payload: await Bun.zstdCompress(JSON.stringify(parts)),
        objects: chunks,
        refs: [...chunks.keys()],
      };
      await this.store.ingest(body, {
        prepared,
        finalizeUpload: id,
        completedBy: completedBy === id ? undefined : completedBy,
        manifestHash: upload.manifest_hash,
        now: this.clock,
      });
    } catch (error) {
      if (error instanceof LedgerError && [400, 500].includes(error.status))
        this.transaction(() => {
          this.store.db
            .query(
              "UPDATE uploads SET state='failed',reason='assembly_integrity_failed',manifest=NULL,updated_at=? WHERE upload_id=? AND state='partial'",
            )
            .run(this.clock(), id);
          this.store.db.query('DELETE FROM pending_pins WHERE upload_id=?').run(id);
          this.collect();
        });
      throw error;
    }
  }
  state(id: string) {
    const upload = this.get(id);
    if (!upload) return fail(404, 'upload_not_found');
    if (upload.state === 'expired' || upload.state === 'failed') return fail(410, 'upload_expired');
    if (upload.state === 'complete') {
      if (!this.store.db.query('SELECT 1 FROM requests WHERE id=?').get(upload.record_id))
        fail(410, 'upload_record_evicted');
      return {
        wire_version: WIRE_VERSION,
        upload_id: id,
        state: 'complete',
        missing: [],
        missing_count: 0,
        missing_bytes: 0,
        more: false,
        record_id: upload.record_id,
        envelope_hash: upload.envelope_hash,
      };
    }
    const missing = this.store.db
      .query<{ idx: number; length: number }, [string]>(
        'SELECT p.idx,p.length FROM pending_pins p LEFT JOIN objects o ON p.hash=o.hash WHERE p.upload_id=? AND o.hash IS NULL ORDER BY p.priority DESC,p.idx',
      )
      .all(id);
    return {
      wire_version: WIRE_VERSION,
      upload_id: id,
      state: 'partial',
      missing: missing.slice(0, 4096).map((ref) => ref.idx),
      missing_count: missing.length,
      missing_bytes: missing.reduce((n, ref) => n + ref.length, 0),
      more: missing.length > 4096,
      expires_at: upload.expires_at,
    };
  }
  list(): { uploads: Record<string, unknown>[] } {
    return {
      uploads: this.store.db
        .query(
          `SELECT u.upload_id,u.state,u.reason,u.created_at,u.expires_at,u.completed_at,u.completed_by_upload_id,u.record_id,u.envelope_bytes,u.hint,count(p.hash) object_count,coalesce(sum(CASE WHEN o.hash IS NOT NULL THEN p.length ELSE 0 END),0) received_object_bytes,coalesce(sum(CASE WHEN p.hash IS NOT NULL AND o.hash IS NULL THEN 1 ELSE 0 END),0) missing_count,coalesce(sum(CASE WHEN o.hash IS NULL THEN p.length ELSE 0 END),0) missing_bytes FROM uploads u LEFT JOIN pending_pins p ON p.upload_id=u.upload_id LEFT JOIN objects o ON o.hash=p.hash GROUP BY u.upload_id ORDER BY u.created_at DESC LIMIT 116`,
        )
        .all()
        .map((value) => {
          const row = value as Record<string, unknown>;
          return {
            ...row,
            hint: JSON.parse(String(row.hint)),
            hint_verified: false,
            transport: 'assembled-wire-v2',
          };
        }),
    };
  }
  private collect() {
    this.store.db
      .query(
        'DELETE FROM objects WHERE refcount=0 AND NOT EXISTS(SELECT 1 FROM pending_pins p WHERE p.hash=objects.hash)',
      )
      .run();
  }
  private trimTerminal() {
    this.store.db
      .query(
        "DELETE FROM uploads WHERE state<>'partial' AND (updated_at<? OR upload_id NOT IN(SELECT upload_id FROM uploads WHERE state<>'partial' ORDER BY updated_at DESC LIMIT 100))",
      )
      .run(this.clock() - 86400000);
  }
  private async expire() {
    this.transaction(() => {
      const now = this.clock();
      const ids = this.store.db
        .query<{ upload_id: string }, [number]>(
          "SELECT upload_id FROM uploads WHERE state='partial' AND expires_at<=? LIMIT 16",
        )
        .all(now);
      for (const row of ids) {
        this.store.db
          .query(
            "UPDATE uploads SET state='expired',reason='ttl_expired',manifest=NULL,updated_at=? WHERE upload_id=?",
          )
          .run(now, row.upload_id);
        this.store.db.query('DELETE FROM pending_pins WHERE upload_id=?').run(row.upload_id);
      }
      this.collect();
      this.trimTerminal();
    });
  }
  async maintain() {
    const operation = this.queue.then(async () => {
      await this.expire();
      const id = this.ready();
      if (id) await this.finalize(id, id);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
