import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { NormalizedRequest } from './normalize/types';
import type { SearchProjection, SearchToolEvidence } from './search-evidence';

export const searchSchema = `
CREATE INDEX IF NOT EXISTS requests_search_output ON requests(search_session_key,search_output_hash)
 WHERE search_session_key IS NOT NULL AND search_output_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS tool_call_origins (
 record_id INTEGER NOT NULL, session_key TEXT NOT NULL, thread_key TEXT NOT NULL,
 call_id TEXT NOT NULL, kind TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(record_id,call_id,kind));
CREATE INDEX IF NOT EXISTS tool_call_origin_lookup ON tool_call_origins(session_key,thread_key,call_id,kind,received_at,record_id);
CREATE TABLE IF NOT EXISTS tool_output_candidates (
 record_id INTEGER NOT NULL, item_index INTEGER NOT NULL, part_index INTEGER NOT NULL,
 call_id TEXT NOT NULL, session_key TEXT NOT NULL, thread_key TEXT NOT NULL, kind TEXT NOT NULL,
 output_hash TEXT NOT NULL, PRIMARY KEY(record_id,item_index,part_index));
CREATE INDEX IF NOT EXISTS tool_candidate_origin ON tool_output_candidates(session_key,thread_key,call_id);
CREATE TABLE IF NOT EXISTS tool_output_parts (
 record_id INTEGER NOT NULL, item_index INTEGER NOT NULL, part_index INTEGER NOT NULL,
 call_id TEXT NOT NULL, session_key TEXT NOT NULL, output_hash TEXT NOT NULL,
 PRIMARY KEY(record_id,item_index,part_index));
CREATE INDEX IF NOT EXISTS tool_output_lookup ON tool_output_parts(session_key,output_hash);
CREATE TABLE IF NOT EXISTS search_links (
 search_record_id INTEGER PRIMARY KEY, consumer_record_id INTEGER NOT NULL,
 item_index INTEGER NOT NULL, part_index INTEGER NOT NULL, call_id TEXT NOT NULL,
 UNIQUE(consumer_record_id,item_index,part_index));
CREATE INDEX IF NOT EXISTS search_links_consumer ON search_links(consumer_record_id);
`;

export const searchConversationColumns = {
  search_count: 'INTEGER NOT NULL DEFAULT 0',
  search_known_charge: 'REAL NOT NULL DEFAULT 0',
  search_unknown_charge: 'INTEGER NOT NULL DEFAULT 0',
  search_known_charge_usd: 'REAL NOT NULL DEFAULT 0',
  search_unknown_charge_usd: 'INTEGER NOT NULL DEFAULT 0',
} as const;

/** Own turns and attached searches retain independent completeness counters. */
export function publishCharges(db: Database, id: number) {
  db.query(`UPDATE conversations SET
    known_charge=CASE WHEN own_turns=unknown_charge THEN 0 ELSE known_charge END,
    charge_quota=CASE WHEN unknown_charge+search_unknown_charge=0 THEN
      (CASE WHEN own_turns=unknown_charge THEN 0 ELSE known_charge END)+search_known_charge ELSE NULL END,
    charge_usd=CASE WHEN unknown_charge_usd+search_unknown_charge_usd=0 THEN
      known_charge_usd+search_known_charge_usd ELSE NULL END,
    charge_partial=unknown_charge+search_unknown_charge>0 OR unknown_charge_usd+search_unknown_charge_usd>0
    WHERE id=?`).run(id);
}

interface Key {
  session_key: string;
  output_hash: string;
}
interface Part extends Key {
  record_id: number;
  item_index: number;
  part_index: number;
  call_id: string;
}
interface Candidate extends Part {
  thread_key: string;
  kind: 'web' | 'exec';
  received_at: number;
}
interface Link {
  search_record_id: number;
  consumer_record_id: number;
  item_index: number;
  part_index: number;
  call_id: string;
}
interface Origin {
  record_id: number;
  received_at: number;
  kind: string;
}

/** All methods run synchronously inside the root write transaction. */
export class SearchIndex {
  constructor(readonly db: Database) {}

  insert(
    id: number,
    n: NormalizedRequest,
    projection: SearchProjection | null,
    evidence: SearchToolEvidence,
    boundary: number | null,
  ) {
    const keys = new Map<string, Key>();
    const affect = (key: Key) => keys.set(`${key.session_key}:${key.output_hash}`, key);
    if (projection?.sessionKey && projection.outputHash)
      affect({ session_key: projection.sessionKey, output_hash: projection.outputHash });
    const session = n.identity?.sessionKey;
    const thread = n.identity?.threadKey;
    if (n.protocol === 'openai_responses' && session && thread) {
      const current = this.db
        .query<{ received_at: number }, [number]>('SELECT received_at FROM requests WHERE id=?')
        .get(id)!;
      const calls = new Set<string>();
      const novel = new Set<string>();
      const seen = new Set<string>();
      for (const origin of evidence.origins) {
        const key = JSON.stringify([origin.callId, origin.kind]);
        if (seen.has(key)) continue;
        seen.add(key);
        const earliest = this.firstOrigin(session, thread, origin.callId, origin.kind);
        this.db
          .query('INSERT OR IGNORE INTO tool_call_origins VALUES(?,?,?,?,?,?)')
          .run(id, session, thread, origin.callId, origin.kind, current.received_at);
        if (
          !earliest ||
          current.received_at < earliest.received_at ||
          (current.received_at === earliest.received_at && id < earliest.record_id)
        ) {
          calls.add(origin.callId);
          novel.add(origin.callId);
        }
      }
      if (boundary !== null) {
        for (const part of evidence.parts) {
          if (part.itemIndex < boundary) continue;
          this.db
            .query('INSERT INTO tool_output_candidates VALUES(?,?,?,?,?,?,?,?)')
            .run(
              id,
              part.itemIndex,
              part.partIndex,
              part.callId,
              session,
              thread,
              part.kind,
              part.outputHash,
            );
          calls.add(part.callId);
        }
      }
      for (const call of calls) {
        const origins = ['web', 'exec', 'other'].flatMap((kind) => {
          const origin = this.firstOrigin(session, thread, call, kind);
          return origin ? [origin] : [];
        });
        for (const candidate of this.db
          .query<Candidate, SQLQueryBindings[]>(
            `SELECT c.*,r.received_at FROM tool_output_candidates c JOIN requests r ON r.id=c.record_id
           WHERE c.session_key=? AND c.thread_key=? AND c.call_id=?${novel.has(call) ? '' : ' AND c.record_id=?'}`,
          )
          .iterate(session, thread, call, ...(novel.has(call) ? [] : [id]))) {
          const grounded = origins.filter(
            (origin) =>
              origin.received_at < candidate.received_at ||
              (origin.received_at === candidate.received_at &&
                origin.record_id <= candidate.record_id),
          );
          affect(candidate);
          if (grounded.length === 1 && grounded[0].kind === candidate.kind)
            this.db
              .query('INSERT OR IGNORE INTO tool_output_parts VALUES(?,?,?,?,?,?)')
              .run(
                candidate.record_id,
                candidate.item_index,
                candidate.part_index,
                candidate.call_id,
                session,
                candidate.output_hash,
              );
          else
            this.db
              .query(
                'DELETE FROM tool_output_parts WHERE record_id=? AND item_index=? AND part_index=?',
              )
              .run(candidate.record_id, candidate.item_index, candidate.part_index);
        }
      }
    }
    for (const key of keys.values()) this.reconcile(key);
  }

  private firstOrigin(session: string, thread: string, call: string, kind: string) {
    return this.db
      .query<Origin, [string, string, string, string]>(
        `SELECT record_id,received_at,kind FROM tool_call_origins
       WHERE session_key=? AND thread_key=? AND call_id=? AND kind=?
       ORDER BY received_at,record_id LIMIT 1`,
      )
      .get(session, thread, call, kind);
  }

  private reconcile(key: Key) {
    const searches = this.db
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM requests WHERE search_session_key=? AND search_output_hash=?
       AND search_session_key IS NOT NULL AND search_output_hash IS NOT NULL LIMIT 2`,
      )
      .all(key.session_key, key.output_hash);
    const parts = this.db
      .query<Part, [string, string]>(
        'SELECT * FROM tool_output_parts WHERE session_key=? AND output_hash=? LIMIT 2',
      )
      .all(key.session_key, key.output_hash);
    // Include existing links even after a conflicting origin removed its proven part.
    const links = this.db
      .query<Link, [string, string]>(
        `SELECT l.* FROM search_links l JOIN requests s ON s.id=l.search_record_id
       WHERE s.search_session_key=? AND s.search_output_hash=?
       AND s.search_session_key IS NOT NULL AND s.search_output_hash IS NOT NULL`,
      )
      .all(key.session_key, key.output_hash);
    const search = searches.length === 1 ? searches[0] : null;
    const part = parts.length === 1 ? parts[0] : null;
    for (const link of links) {
      if (
        search &&
        part &&
        link.search_record_id === search.id &&
        link.consumer_record_id === part.record_id &&
        link.item_index === part.item_index &&
        link.part_index === part.part_index
      )
        return;
      this.unlink(link);
    }
    if (!search || !part) return;
    this.db
      .query('INSERT INTO search_links VALUES(?,?,?,?,?)')
      .run(search.id, part.record_id, part.item_index, part.part_index, part.call_id);
    this.charge(search.id, part.record_id, 1);
  }

  private charge(searchId: number, consumerId: number, direction: 1 | -1) {
    const row = this.db
      .query<
        { conversation_id: number | null; charge_quota: number | null; charge_usd: number | null },
        [number, number]
      >(
        'SELECT c.conversation_id,s.charge_quota,s.charge_usd FROM requests c JOIN requests s ON s.id=? WHERE c.id=?',
      )
      .get(searchId, consumerId);
    if (row?.conversation_id === null || !row) return;
    const quotaUnknown = row.charge_quota === null ? direction : 0;
    const usdUnknown = row.charge_usd === null ? direction : 0;
    this.db
      .query(`UPDATE conversations SET search_count=search_count+?,
      search_known_charge=CASE WHEN search_count+?=search_unknown_charge+? THEN 0 ELSE search_known_charge+? END,
      search_unknown_charge=search_unknown_charge+?,
      search_known_charge_usd=CASE WHEN search_count+?=search_unknown_charge_usd+? THEN 0 ELSE search_known_charge_usd+? END,
      search_unknown_charge_usd=search_unknown_charge_usd+? WHERE id=?`)
      .run(
        direction,
        direction,
        quotaUnknown,
        direction * (row.charge_quota ?? 0),
        quotaUnknown,
        direction,
        usdUnknown,
        direction * (row.charge_usd ?? 0),
        usdUnknown,
        row.conversation_id,
      );
    publishCharges(this.db, row.conversation_id);
  }

  private unlink(link: Link) {
    this.charge(link.search_record_id, link.consumer_record_id, -1);
    this.db.query('DELETE FROM search_links WHERE search_record_id=?').run(link.search_record_id);
  }

  /** Deletion only removes edges; reduced ambiguity must never resurrect one. */
  remove(id: number) {
    for (const link of this.db
      .query<Link, [number]>('SELECT * FROM search_links WHERE search_record_id=?')
      .all(id))
      this.unlink(link);
    for (const link of this.db
      .query<Link, [number]>('SELECT * FROM search_links WHERE consumer_record_id=?')
      .all(id))
      this.unlink(link);
    for (const table of ['tool_output_parts', 'tool_output_candidates', 'tool_call_origins'])
      this.db.query(`DELETE FROM ${table} WHERE record_id=?`).run(id);
  }
}

export const searchTables = [
  'tool_call_origins',
  'tool_output_candidates',
  'tool_output_parts',
  'search_links',
] as const;

export function copyRows(source: Database, destination: Database, table: string) {
  for (const row of source
    .query<Record<string, SQLQueryBindings>, []>(`SELECT * FROM ${table}`)
    .iterate()) {
    const columns = Object.keys(row);
    destination
      .query(
        `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      )
      .run(...Object.values(row));
  }
}
