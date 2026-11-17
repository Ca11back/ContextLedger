/** Read-only shadow replay. Source schema4 is never migrated or opened by Ledger.
 * bun run <this-file> --database /absolute/ledger.sqlite --max-id 372
 * May be bundled as a single file and executed from stdin. Only numeric counts,
 * static categories and evidence hashes leave the process; no evidence cache or files.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { Envelope } from '../../src/contracts';
import { decodeParts, hash, verify } from '../../src/server/codec';
import {
  ConversationIndex,
  type IndexMeta,
  installConversationSchema,
} from '../../src/server/linking';
import { normalizeEnvelope } from '../../src/server/normalize';

const CUTOFF = 372;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SELECTED = new Set([41, 42, 43, 44, 261, 372]);
interface RootMeta extends IndexMeta {
  id: number;
  body_hash: string;
  body_length: number;
  storage_mode: string;
  conversation_id: number | null;
  turn_index: number | null;
  completeness: string;
  parent_id: number | null;
  link_rule: string | null;
  parent_coverage: number;
}
interface Assignment {
  id: number;
  conversationId: number | null;
  turnIndex: number | null;
  parentId: number | null;
  linkRule: string | null;
  parentCoverage: number;
}
function scalar(db: Database, sql: string, ...args: SQLQueryBindings[]): number {
  return Number(Object.values(db.query(sql).get(...args) as Record<string, unknown>)[0]);
}
function digest(rows: { id: number; body_hash: string; body_length: number }[]): string {
  return hash(JSON.stringify(rows.map((row) => [row.id, row.body_hash, row.body_length])));
}
function restore(source: Database, meta: RootMeta): Uint8Array {
  const row = source
    .query<{ payload: Uint8Array; body_hash: string; body_length: number }, [number]>(
      'SELECT payload,body_hash,body_length FROM requests WHERE id=?',
    )
    .get(meta.id);
  if (!row || row.body_hash !== meta.body_hash || row.body_length !== meta.body_length)
    throw new Error('source_snapshot_changed');
  if (meta.body_length < 0 || meta.body_length > MAX_BODY_BYTES)
    throw new Error('source_body_budget');
  let bytes: Uint8Array;
  if (meta.storage_mode === 'whole_zstd') bytes = Bun.zstdDecompressSync(row.payload);
  else if (meta.storage_mode === 'item_cas') {
    let length = 0;
    const pieces: Uint8Array[] = [];
    for (const part of decodeParts(row.payload)) {
      let piece: Uint8Array;
      if ('literal' in part) piece = Buffer.from(part.literal);
      else {
        const object = source
          .query<
            { compressed: Uint8Array; length: number; codec: string; refcount: number },
            [string]
          >('SELECT compressed,length,codec,refcount FROM objects WHERE hash=?')
          .get(part.hash);
        if (object?.codec !== 'zstd-v1' || object.refcount < 1 || object.length > MAX_BODY_BYTES)
          throw new Error('source_object_integrity');
        piece = Bun.zstdDecompressSync(object.compressed);
        verify(piece, part.hash, object.length);
      }
      length += piece.length;
      if (length > meta.body_length) throw new Error('source_body_budget');
      pieces.push(piece);
    }
    bytes = Buffer.concat(pieces, length);
  } else throw new Error('source_storage_mode');
  verify(bytes, meta.body_hash, meta.body_length);
  return bytes;
}
function assignment(
  row: Pick<
    RootMeta,
    'id' | 'conversation_id' | 'turn_index' | 'parent_id' | 'link_rule' | 'parent_coverage'
  >,
): Assignment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnIndex: row.turn_index,
    parentId: row.parent_id,
    linkRule: row.link_rule,
    parentCoverage: row.parent_coverage,
  };
}

export function estimatePartial(database: string, maxId = CUTOFF) {
  if (maxId !== CUTOFF) throw new Error('fixed_cutoff_required');
  const source = new Database(database, { readonly: true, strict: true });
  const stage = new Database(':memory:', { strict: true });
  try {
    source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const version = scalar(source, 'PRAGMA user_version');
    if (version !== 4) throw new Error('source_schema_not_supported');
    // Snapshot only bounded scalar metadata. Release this read transaction before any
    // restoration, decompression or normalization; concurrent retention fails closed.
    const takeSnapshot = source.transaction(() => {
      const rows = source
        .query<RootMeta, [number]>(`SELECT id,source,received_at,model,usage_json,cost_json,
        body_hash,body_length,storage_mode,conversation_id,turn_index,completeness,parent_id,link_rule,parent_coverage
        FROM requests WHERE id<=? ORDER BY received_at,id`)
        .all(maxId);
      if (rows.length > CUTOFF) throw new Error('source_row_budget');
      const conversations = source
        .query<
          { id: number; empty: number; branch: number },
          [number]
        >(`SELECT c.id,c.title='' AS empty,
        c.forked_from_conversation IS NOT NULL AS branch FROM conversations c
        WHERE EXISTS(SELECT 1 FROM requests r WHERE r.conversation_id=c.id AND r.id<=?)`)
        .all(maxId);
      return { rows, conversations };
    });
    const snapshot = takeSnapshot();
    const metadataDigest = hash(JSON.stringify(snapshot));
    stage.exec(`CREATE TABLE requests(id INTEGER PRIMARY KEY,source TEXT NOT NULL,received_at INTEGER NOT NULL,
      model TEXT NOT NULL,usage_json TEXT NOT NULL,cost_json TEXT NOT NULL,body_hash TEXT NOT NULL,body_length INTEGER NOT NULL)`);
    installConversationSchema(stage);
    const index = new ConversationIndex(stage);
    const baselineStatuses = new Map<number, { error: boolean; partial: boolean; turn: number }>();
    const beforeDigest = digest(snapshot.rows);
    let verified = 0;
    for (const meta of snapshot.rows) {
      if (
        meta.conversation_id !== null &&
        (baselineStatuses.get(meta.conversation_id)?.turn ?? -1) < meta.turn_index!
      ) {
        baselineStatuses.set(meta.conversation_id, {
          error: meta.completeness === 'error',
          partial: meta.completeness === 'partial',
          turn: meta.turn_index!,
        });
      }
      const envelope = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(restore(source, meta)),
      ) as Envelope;
      if (
        envelope.version !== 1 ||
        envelope.source !== meta.source ||
        !envelope.report ||
        !envelope.context
      )
        throw new Error('source_envelope_integrity');
      verified++;
      const prepared = index.prepare(normalizeEnvelope(envelope), meta);
      stage.transaction(() => {
        stage
          .query(
            'INSERT INTO requests(id,source,received_at,model,usage_json,cost_json,body_hash,body_length) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            meta.id,
            meta.source,
            meta.received_at,
            meta.model,
            meta.usage_json,
            meta.cost_json,
            meta.body_hash,
            meta.body_length,
          );
        index.insert(meta.id, meta, prepared);
      })();
    }
    const afterRows = stage
      .query<RootMeta, []>('SELECT id,body_hash,body_length FROM requests ORDER BY received_at,id')
      .all();
    const afterDigest = digest(afterRows);
    const recheck = takeSnapshot();
    if (
      hash(JSON.stringify(recheck)) !== metadataDigest ||
      digest(recheck.rows) !== beforeDigest ||
      afterDigest !== beforeDigest ||
      verified !== snapshot.rows.length
    )
      throw new Error('source_snapshot_changed');
    const selectedBefore = snapshot.rows.filter((row) => SELECTED.has(row.id)).map(assignment);
    const selectedAfter = stage
      .query<RootMeta, []>(
        'SELECT id,conversation_id,turn_index,parent_id,link_rule,parent_coverage FROM requests ORDER BY id',
      )
      .all()
      .filter((row) => SELECTED.has(row.id))
      .map(assignment);
    const result = {
      cutoff: maxId,
      sourceSchema: version,
      shadowSchema: 5,
      verifiedRecords: verified,
      sourceMetadataDigest: metadataDigest,
      verifiedSourceMetadataDigest: hash(JSON.stringify(recheck)),
      before: {
        requests: snapshot.rows.length,
        evidenceDigest: beforeDigest,
        conversations: snapshot.conversations.length,
        branches: snapshot.conversations.filter((row) => row.branch).length,
        emptyTitles: snapshot.conversations.filter((row) => row.empty).length,
        red: [...baselineStatuses.values()].filter((row) => row.error).length,
        partial: [...baselineStatuses.values()].filter((row) => row.partial).length,
      },
      after: {
        requests: afterRows.length,
        evidenceDigest: afterDigest,
        conversations: scalar(stage, 'SELECT count(*) FROM conversations'),
        branches: scalar(
          stage,
          'SELECT count(*) FROM conversations WHERE forked_from_conversation IS NOT NULL',
        ),
        emptyTitles: scalar(stage, "SELECT count(*) FROM conversations WHERE title=''"),
        red: scalar(stage, 'SELECT count(*) FROM conversations WHERE has_error=1'),
        partial: scalar(stage, 'SELECT count(*) FROM conversations WHERE has_partial=1'),
      },
      selectedBefore,
      selectedAfter,
    };
    return result;
  } finally {
    stage.close();
    source.close();
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 4 ||
      args[0] !== '--database' ||
      args[2] !== '--max-id' ||
      args[3] !== String(CUTOFF) ||
      !args[1]
    )
      throw new Error('usage');
    console.log(JSON.stringify(estimatePartial(args[1], CUTOFF)));
  } catch {
    console.error(
      JSON.stringify({ event: 'partial_estimate_failed', code: 'readonly_shadow_failed' }),
    );
    process.exitCode = 1;
  }
}
