import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { Envelope } from '../contracts';
import { object } from '../contracts';
import { normalizeEnvelope } from './normalize';
import type { NormalizedRequest } from './normalize/types';

export const requestIndexColumns = {
  user_id: 'TEXT',
  token_id: 'TEXT',
  protocol: "TEXT NOT NULL DEFAULT ''",
  completeness: "TEXT NOT NULL DEFAULT 'partial'",
  input_count: 'INTEGER NOT NULL DEFAULT 0',
  evidence_count: 'INTEGER NOT NULL DEFAULT 0',
  input_chain: 'TEXT',
  retry_input_chain: 'TEXT',
  previous_response_id: 'TEXT',
  retry_of: 'INTEGER',
  retry_of_turn: 'INTEGER',
  superseded: 'INTEGER NOT NULL DEFAULT 0',
  continuation_eligible: 'INTEGER NOT NULL DEFAULT 0',
  last_user_text: "TEXT NOT NULL DEFAULT ''",
  evidence_chain: 'TEXT',
  response_id: 'TEXT',
  parent_id: 'INTEGER',
  link_rule: 'TEXT',
  conversation_id: 'INTEGER',
  turn_index: 'INTEGER',
  parent_coverage: 'INTEGER NOT NULL DEFAULT 0',
  client_kind: 'TEXT',
  thread_key: 'TEXT',
  session_key: 'TEXT',
  parent_thread_key: 'TEXT',
  window_key: 'TEXT',
  context_reset: 'TEXT',
  input_tokens: 'REAL',
  output_tokens: 'REAL',
  charge_quota: 'REAL',
  stop_reason: 'TEXT',
} as const;
export const conversationSchema = `
CREATE TABLE IF NOT EXISTS conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, user_id TEXT, token_id TEXT, protocol TEXT NOT NULL,
 title TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
 own_turns INTEGER NOT NULL DEFAULT 0, inherited_turns INTEGER NOT NULL DEFAULT 0,
 models TEXT NOT NULL DEFAULT '[]', more_models INTEGER NOT NULL DEFAULT 0,
 input_tokens REAL NOT NULL DEFAULT 0, output_tokens REAL NOT NULL DEFAULT 0, charge_quota REAL,
 charge_partial INTEGER NOT NULL DEFAULT 0, has_error INTEGER NOT NULL DEFAULT 0, has_partial INTEGER NOT NULL DEFAULT 0,
 forked_from_conversation INTEGER, forked_from_turn INTEGER, branch_count INTEGER NOT NULL DEFAULT 0, thread_key TEXT,
 next_turn INTEGER NOT NULL DEFAULT 1, unknown_charge INTEGER NOT NULL DEFAULT 0,
 error_turns INTEGER NOT NULL DEFAULT 0, partial_turns INTEGER NOT NULL DEFAULT 0, known_charge REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS conversations_activity ON conversations(last_at,id);
CREATE INDEX IF NOT EXISTS conversations_fork ON conversations(forked_from_conversation,id);
CREATE INDEX IF NOT EXISTS conversations_thread ON conversations(thread_key,id);
CREATE TABLE IF NOT EXISTS threads (
 thread_key TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT NOT NULL, token_id TEXT NOT NULL, protocol TEXT NOT NULL,
 session_key TEXT, primary_conversation_id INTEGER NOT NULL, primary_next_turn INTEGER NOT NULL DEFAULT 1, parent_thread_key TEXT, subagent_of INTEGER,
 agent_name TEXT, subagent_kind TEXT, subagent_count INTEGER NOT NULL DEFAULT 0, conflict INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS threads_primary ON threads(primary_conversation_id);
CREATE INDEX IF NOT EXISTS threads_session ON threads(session_key);
CREATE INDEX IF NOT EXISTS threads_parent ON threads(parent_thread_key);
CREATE INDEX IF NOT EXISTS threads_subagent ON threads(subagent_of,thread_key);
CREATE TABLE IF NOT EXISTS conversation_models(conversation_id INTEGER NOT NULL, model TEXT NOT NULL, turns INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,model));
CREATE INDEX IF NOT EXISTS requests_evidence ON requests(source,user_id,token_id,protocol,evidence_chain);
CREATE INDEX IF NOT EXISTS requests_response ON requests(source,user_id,token_id,protocol,response_id);
CREATE INDEX IF NOT EXISTS requests_thread ON requests(thread_key);
CREATE INDEX IF NOT EXISTS requests_session ON requests(session_key);
CREATE INDEX IF NOT EXISTS requests_parent_thread ON requests(parent_thread_key);
CREATE INDEX IF NOT EXISTS requests_conversation ON requests(conversation_id,turn_index);
CREATE INDEX IF NOT EXISTS requests_conversation_time ON requests(conversation_id,received_at,id);
CREATE INDEX IF NOT EXISTS requests_parent ON requests(parent_id);
CREATE INDEX IF NOT EXISTS requests_parent_eligible ON requests(parent_id,continuation_eligible);
CREATE INDEX IF NOT EXISTS requests_retry ON requests(source,user_id,token_id,protocol,parent_id,thread_key,retry_input_chain,previous_response_id,received_at,id);
`;
export function installConversationSchema(db: Database) {
  const existing = new Set(
    (db.query('PRAGMA table_info(requests)').all() as { name: string }[]).map((c) => c.name),
  );
  for (const [column, definition] of Object.entries(requestIndexColumns))
    if (!existing.has(column)) db.exec(`ALTER TABLE requests ADD COLUMN ${column} ${definition}`);
  db.exec(conversationSchema);
}
interface Parent {
  id: number;
  source: string;
  user_id: string | null;
  token_id: string | null;
  protocol: string;
  completeness: string;
  evidence_chain: string | null;
  evidence_count: number;
  response_id: string | null;
  conversation_id: number;
  turn_index: number;
  thread_key: string | null;
}
interface Retry {
  id: number;
  conversation_id: number;
  turn_index: number;
  parent_id: number | null;
  retry_input_chain: string;
  previous_response_id: string | null;
  thread_key: string | null;
}
interface Thread {
  thread_key: string;
  session_key: string | null;
  primary_conversation_id: number;
  primary_next_turn: number;
  parent_thread_key: string | null;
  subagent_of: number | null;
  conflict: number;
}
interface Conversation {
  id: number;
  next_turn: number;
  inherited_turns: number;
  forked_from_conversation: number | null;
  thread_key: string | null;
}
export interface IndexMeta {
  source: string;
  received_at: number;
  model: string;
  usage_json: string;
  cost_json: string;
}
export interface PreparedIndex {
  normalized: NormalizedRequest;
  parent: Parent | null;
  retry: Retry | null;
  continuationEligible: boolean;
  title: string;
  inputTokens: number | null;
  outputTokens: number | null;
  charge: number | null;
}
const parentColumns =
  'id,source,user_id,token_id,protocol,completeness,evidence_chain,evidence_count,response_id,conversation_id,turn_index,thread_key';
const numeric = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Only hashes and bounded summaries are stored; normalized text remains ephemeral. */
export class ConversationIndex {
  constructor(readonly db: Database) {}
  prepare(normalized: NormalizedRequest, meta: IndexMeta): PreparedIndex {
    const n = normalized;
    let parent: Parent | null = null;
    if (n.chat && n.domain) {
      const domain = [meta.source, n.userId, n.tokenId, n.protocol];
      const scope = n.identity ? ' AND thread_key=?' : '';
      const args = n.identity ? [...domain, n.identity.threadKey] : domain;
      if (n.previousResponseId) {
        const rows = this.db
          .query<Parent, SQLQueryBindings[]>(
            `SELECT ${parentColumns} FROM requests WHERE source=? AND user_id=? AND token_id=? AND protocol=?${scope} AND response_id=? AND completeness!='error' LIMIT 2`,
          )
          .all(...args, n.previousResponseId);
        if (rows.length === 1) parent = rows[0];
      } else {
        const hashes = n.inputPrefixes.slice(-4096);
        let best = 0,
          tied = false;
        for (let i = 0; i < hashes.length; i += 500) {
          const batch = hashes.slice(i, i + 500);
          const rows = this.db
            .query<Parent, SQLQueryBindings[]>(
              `SELECT ${parentColumns} FROM requests WHERE source=? AND user_id=? AND token_id=? AND protocol=?${scope} AND completeness!='error' AND evidence_chain IN (${batch.map(() => '?').join(',')})`,
            )
            .all(...args, ...batch);
          for (const row of rows) {
            if (row.evidence_count > best) {
              best = row.evidence_count;
              parent = row;
              tied = false;
            } else if (row.evidence_count === best && row.id !== parent?.id) tied = true;
          }
        }
        if (tied) parent = null;
      }
    }
    let retry: Retry | null = null;
    // Unanchored undeclared roots must never merge solely on a common prompt.
    if (n.chat && n.domain && (parent || n.identity || n.previousResponseId)) {
      retry = this.db
        .query<
          Retry,
          SQLQueryBindings[]
        >(`SELECT id,conversation_id,turn_index,parent_id,retry_input_chain,previous_response_id,thread_key FROM requests
        WHERE source=? AND user_id=? AND token_id=? AND protocol=? AND parent_id IS ? AND thread_key IS ?
        AND retry_input_chain=? AND previous_response_id IS ? AND conversation_id IS NOT NULL
        ORDER BY received_at DESC,id DESC LIMIT 1`)
        .get(
          meta.source,
          n.userId,
          n.tokenId,
          n.protocol,
          parent?.id ?? null,
          n.identity?.threadKey ?? null,
          n.retryInputChain,
          n.previousResponseId,
        );
    }
    const start = n.previousResponseId ? 0 : parent ? parent.evidence_count : n.leadingHistoryCount;
    const title = n.input.slice(start).find((m) => m.userText)?.userText || n.lastUserText;
    const usage = object(JSON.parse(meta.usage_json)),
      cost = object(JSON.parse(meta.cost_json));
    return {
      normalized: n,
      parent,
      retry,
      continuationEligible: n.previousResponseId
        ? n.completeness !== 'error' &&
          n.output.some(
            (m) =>
              m.completed &&
              m.evidence &&
              (m.kind === 'assistant' || m.kind === 'tool_call') &&
              m.parts.some((p) => p.text.length > 0),
          )
        : n.evidenceChain !== null,
      title: title.slice(0, 120),
      inputTokens: numeric(usage.promptTokens),
      outputTokens: numeric(usage.completionTokens),
      charge: numeric(cost.quota),
    };
  }
  /** Call synchronously in the root transaction immediately after prepare, with no await. */
  insert(id: number, meta: IndexMeta, prepared: PreparedIndex) {
    const { normalized: n } = prepared;
    let parent = prepared.parent;
    if (parent) {
      const live = this.db
        .query<Parent, [number]>(`SELECT ${parentColumns} FROM requests WHERE id=?`)
        .get(parent.id);
      if (
        !live ||
        live.source !== meta.source ||
        live.user_id !== n.userId ||
        live.token_id !== n.tokenId ||
        live.protocol !== n.protocol ||
        live.completeness !== parent.completeness ||
        live.completeness === 'error' ||
        live.evidence_chain !== parent.evidence_chain ||
        live.response_id !== parent.response_id ||
        (n.identity && live.thread_key !== n.identity.threadKey)
      )
        parent = null;
      else parent = live;
    }
    let retry = prepared.retry;
    if (retry) {
      const live = this.db
        .query<
          Retry & {
            source: string;
            user_id: string | null;
            token_id: string | null;
            protocol: string;
          },
          [number]
        >(
          'SELECT id,source,user_id,token_id,protocol,conversation_id,turn_index,parent_id,retry_input_chain,previous_response_id,thread_key FROM requests WHERE id=?',
        )
        .get(retry.id);
      if (
        !live ||
        live.source !== meta.source ||
        live.user_id !== n.userId ||
        live.token_id !== n.tokenId ||
        live.protocol !== n.protocol ||
        live.parent_id !== (parent?.id ?? null) ||
        live.thread_key !== (n.identity?.threadKey ?? null) ||
        live.retry_input_chain !== n.retryInputChain ||
        live.previous_response_id !== n.previousResponseId ||
        (!parent && !n.identity && !n.previousResponseId)
      )
        retry = null;
      else retry = live;
    }
    let conversation: Conversation | null = null;
    let reset: string | null = null;
    let thread = n.identity
      ? this.db
          .query<Thread, [string]>('SELECT * FROM threads WHERE thread_key=?')
          .get(n.identity.threadKey)
      : null;
    if (n.chat) {
      if (retry) {
        conversation = this.db
          .query<Conversation, [number]>('SELECT * FROM conversations WHERE id=?')
          .get(retry.conversation_id);
        if (!conversation) retry = null;
      }
      if (!conversation && parent) {
        const branching = !!this.db
          .query('SELECT 1 FROM requests WHERE parent_id=? AND continuation_eligible=1 LIMIT 1')
          .get(parent.id);
        if (!branching)
          conversation = this.db
            .query<Conversation, [number]>('SELECT * FROM conversations WHERE id=?')
            .get(parent.conversation_id);
        if (!conversation) conversation = this.createConversation(meta, prepared, parent);
      } else if (!conversation && thread) {
        conversation = this.db
          .query<Conversation, [number]>('SELECT * FROM conversations WHERE id=?')
          .get(thread.primary_conversation_id);
        const previous = this.db
          .query<{ window_key: string | null }, [number]>(
            'SELECT window_key FROM requests WHERE conversation_id=? ORDER BY turn_index DESC LIMIT 1',
          )
          .get(thread.primary_conversation_id);
        reset =
          previous && previous.window_key !== n.identity?.windowKey
            ? 'window_changed'
            : 'no_prefix';
      }
      if (!conversation) {
        conversation = this.createConversation(meta, prepared, null, thread ?? undefined);
      }
      if (n.identity && n.domain) {
        const identity = n.identity;
        if (!thread) {
          this.db
            .query(
              'INSERT INTO threads(thread_key,source,user_id,token_id,protocol,session_key,primary_conversation_id,parent_thread_key,agent_name,subagent_kind) VALUES(?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              identity.threadKey,
              meta.source,
              n.userId!,
              n.tokenId!,
              n.protocol,
              identity.sessionKey,
              conversation.id,
              identity.parentThreadKey,
              identity.agentName,
              identity.subagentKind,
            );
        } else if (
          thread.session_key !== identity.sessionKey ||
          thread.parent_thread_key !== identity.parentThreadKey
        ) {
          this.detachThread(thread);
          this.db.query('UPDATE threads SET conflict=1 WHERE thread_key=?').run(identity.threadKey);
          for (const child of this.db
            .query<Thread, [string]>(
              'SELECT * FROM threads WHERE parent_thread_key=? AND subagent_of IS NOT NULL',
            )
            .all(identity.threadKey))
            this.detachThread(child);
        }
        this.resolveThread(identity.threadKey);
        // One indexed lookup for previously unknown declared parents; no content re-linking.
        for (const child of this.db
          .query<{ thread_key: string }, [string]>(
            'SELECT thread_key FROM threads WHERE parent_thread_key=? AND subagent_of IS NULL AND conflict=0',
          )
          .all(identity.threadKey))
          this.resolveThread(child.thread_key);
        thread = this.db
          .query<Thread, [string]>('SELECT * FROM threads WHERE thread_key=?')
          .get(identity.threadKey);
      }
    }
    const turn = conversation?.next_turn ?? null;
    const rule = parent
      ? n.previousResponseId
        ? 'prev_id'
        : parent.completeness === 'partial'
          ? 'prefix_partial'
          : 'prefix'
      : null;
    const values: Record<keyof typeof requestIndexColumns, SQLQueryBindings> = {
      user_id: n.userId,
      token_id: n.tokenId,
      protocol: n.protocol,
      completeness: n.completeness,
      input_count: n.inputCount,
      evidence_count: n.evidenceCount,
      input_chain: n.inputChain,
      retry_input_chain: n.retryInputChain,
      previous_response_id: n.previousResponseId,
      retry_of: retry?.id ?? null,
      retry_of_turn: retry?.turn_index ?? null,
      superseded: 0,
      continuation_eligible: prepared.continuationEligible ? 1 : 0,
      last_user_text: n.lastUserText,
      evidence_chain: n.evidenceChain,
      response_id: n.responseId,
      parent_id: parent?.id ?? null,
      link_rule: rule,
      conversation_id: conversation?.id ?? null,
      turn_index: turn,
      parent_coverage: parent && !n.previousResponseId ? parent.evidence_count : 0,
      client_kind: n.identity?.clientKind ?? null,
      thread_key: n.identity?.threadKey ?? null,
      session_key: n.identity?.sessionKey ?? null,
      parent_thread_key: n.identity?.parentThreadKey ?? null,
      window_key: n.identity?.windowKey ?? null,
      context_reset: reset,
      input_tokens: prepared.inputTokens,
      output_tokens: prepared.outputTokens,
      charge_quota: prepared.charge,
      stop_reason: n.stopReason?.slice(0, 128) ?? null,
    };
    this.db
      .query(
        `UPDATE requests SET ${Object.keys(values)
          .map((k) => `${k}=?`)
          .join(',')} WHERE id=?`,
      )
      .run(...Object.values(values), id);
    if (conversation) {
      if (retry)
        this.db
          .query('UPDATE requests SET superseded=1 WHERE id=? AND conversation_id=?')
          .run(retry.id, conversation.id);
      this.db
        .query("UPDATE conversations SET title=? WHERE id=? AND title=''")
        .run(prepared.title, conversation.id);
      this.db
        .query(`UPDATE conversations SET own_turns=own_turns+1,next_turn=next_turn+1,first_at=min(first_at,?),last_at=max(last_at,?),
        input_tokens=input_tokens+?,output_tokens=output_tokens+?,known_charge=known_charge+?,unknown_charge=unknown_charge+?,
        error_turns=error_turns+?,partial_turns=partial_turns+? WHERE id=?`)
        .run(
          meta.received_at,
          meta.received_at,
          prepared.inputTokens ?? 0,
          prepared.outputTokens ?? 0,
          prepared.charge ?? 0,
          prepared.charge === null ? 1 : 0,
          n.completeness === 'error' ? 1 : 0,
          n.completeness === 'partial' ? 1 : 0,
          conversation.id,
        );
      this.db
        .query(
          'INSERT INTO conversation_models VALUES(?,?,1) ON CONFLICT(conversation_id,model) DO UPDATE SET turns=turns+1',
        )
        .run(conversation.id, meta.model);
      this.refreshFlags(conversation.id);
      this.db
        .query('UPDATE threads SET primary_next_turn=? WHERE primary_conversation_id=?')
        .run(conversation.next_turn + 1, conversation.id);
    }
  }
  private createConversation(
    meta: IndexMeta,
    p: PreparedIndex,
    parent: Parent | null,
    tombstone?: Thread,
  ): Conversation {
    const inherited = parent
      ? (this.db
          .query<Conversation, [number]>('SELECT * FROM conversations WHERE id=?')
          .get(parent.conversation_id)?.inherited_turns ?? 0) + parent.turn_index
      : 0;
    const result = this.db
      .query(
        'INSERT INTO conversations(id,source,user_id,token_id,protocol,title,first_at,last_at,inherited_turns,forked_from_conversation,forked_from_turn,thread_key,next_turn,branch_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        tombstone?.primary_conversation_id ?? null,
        meta.source,
        p.normalized.userId,
        p.normalized.tokenId,
        p.normalized.protocol,
        parent || p.normalized.previousResponseId ? p.title : p.normalized.title,
        meta.received_at,
        meta.received_at,
        inherited,
        parent?.conversation_id ?? null,
        parent?.turn_index ?? null,
        p.normalized.identity?.threadKey ?? null,
        tombstone?.primary_next_turn ?? 1,
        tombstone
          ? this.db
              .query<{ n: number }, [number]>(
                'SELECT count(*) AS n FROM conversations WHERE forked_from_conversation=?',
              )
              .get(tombstone.primary_conversation_id)!.n
          : 0,
      );
    if (parent)
      this.db
        .query('UPDATE conversations SET branch_count=branch_count+1 WHERE id=?')
        .run(parent.conversation_id);
    return this.db
      .query<Conversation, [number]>('SELECT * FROM conversations WHERE id=?')
      .get(Number(result.lastInsertRowid))!;
  }
  private detachThread(thread: Thread) {
    if (thread.subagent_of !== null) {
      this.db
        .query(
          'UPDATE threads SET subagent_count=max(0,subagent_count-1) WHERE primary_conversation_id=?',
        )
        .run(thread.subagent_of);
      this.db
        .query('UPDATE threads SET subagent_of=NULL WHERE thread_key=?')
        .run(thread.thread_key);
    }
  }
  private resolveThread(key: string) {
    const child = this.db
      .query<Thread, [string]>('SELECT * FROM threads WHERE thread_key=?')
      .get(key);
    if (
      !child ||
      child.conflict ||
      child.subagent_of !== null ||
      !child.parent_thread_key ||
      !child.session_key
    )
      return;
    const parent = this.db
      .query<Thread, [string]>('SELECT * FROM threads WHERE thread_key=?')
      .get(child.parent_thread_key);
    if (!parent || parent.conflict || parent.session_key !== child.session_key) return;
    const visited = new Set([key]);
    let cursor: Thread | null = parent;
    while (cursor) {
      if (visited.has(cursor.thread_key)) return;
      visited.add(cursor.thread_key);
      cursor = cursor.parent_thread_key
        ? this.db
            .query<Thread, [string]>('SELECT * FROM threads WHERE thread_key=?')
            .get(cursor.parent_thread_key)
        : null;
    }
    this.db
      .query('UPDATE threads SET subagent_of=? WHERE thread_key=?')
      .run(parent.primary_conversation_id, key);
    this.db
      .query('UPDATE threads SET subagent_count=subagent_count+1 WHERE thread_key=?')
      .run(parent.thread_key);
  }
  private refreshFlags(id: number, excludedId = -1) {
    const models = this.db
      .query<{ model: string }, [number]>(
        'SELECT model FROM conversation_models WHERE conversation_id=? ORDER BY model LIMIT 5',
      )
      .all(id);
    const count = this.db
      .query<{ n: number }, [number]>(
        'SELECT count(*) AS n FROM conversation_models WHERE conversation_id=?',
      )
      .get(id)!.n;
    this.db
      .query(`UPDATE conversations SET models=?,more_models=?,charge_quota=CASE WHEN unknown_charge=0 THEN known_charge ELSE NULL END,
      charge_partial=unknown_charge>0,
      has_error=coalesce((SELECT completeness='error' FROM requests WHERE conversation_id=? AND id!=? ORDER BY turn_index DESC LIMIT 1),0),
      has_partial=coalesce((SELECT completeness='partial' FROM requests WHERE conversation_id=? AND id!=? ORDER BY turn_index DESC LIMIT 1),0) WHERE id=?`)
      .run(
        JSON.stringify(models.slice(0, 4).map((m) => m.model)),
        Math.max(0, count - 4),
        id,
        excludedId,
        id,
        excludedId,
        id,
      );
  }
  private pruneThread(key: string | null) {
    const visited = new Set<string>();
    while (key && !visited.has(key) && visited.size < 64) {
      visited.add(key);
      const thread = this.db
        .query<Thread, [string]>('SELECT * FROM threads WHERE thread_key=?')
        .get(key);
      if (
        !thread ||
        this.db.query('SELECT 1 FROM conversations WHERE thread_key=? LIMIT 1').get(key) ||
        this.db
          .query(
            'SELECT 1 FROM threads WHERE parent_thread_key=? AND thread_key!=? AND subagent_of IS NOT NULL LIMIT 1',
          )
          .get(key, key) ||
        this.db
          .query('SELECT 1 FROM conversations WHERE forked_from_conversation=? LIMIT 1')
          .get(thread.primary_conversation_id)
      )
        return;
      this.detachThread(thread);
      this.db.query('DELETE FROM threads WHERE thread_key=?').run(key);
      key = thread.parent_thread_key;
    }
  }
  /** Bound orphan reclamation independently of the number of removed roots. */
  cleanupThreads() {
    const rows = this.db
      .query<{ thread_key: string }, []>(`SELECT t.thread_key FROM threads t
      WHERE NOT EXISTS(SELECT 1 FROM conversations c WHERE c.thread_key=t.thread_key)
      AND NOT EXISTS(SELECT 1 FROM threads child WHERE child.parent_thread_key=t.thread_key AND child.thread_key!=t.thread_key AND child.subagent_of IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.forked_from_conversation=t.primary_conversation_id) LIMIT 8`)
      .all();
    for (const row of rows) this.pruneThread(row.thread_key);
  }
  /** Call in root deletion transaction; stable indices and origin ids are never rewritten. */
  remove(id: number) {
    const row = this.db
      .query<
        {
          conversation_id: number | null;
          thread_key: string | null;
          model: string;
          input_tokens: number | null;
          output_tokens: number | null;
          charge_quota: number | null;
          completeness: string;
          parent_id: number | null;
          retry_input_chain: string | null;
          previous_response_id: string | null;
        },
        [number]
      >('SELECT * FROM requests WHERE id=?')
      .get(id);
    if (!row?.conversation_id) return;
    const cid = row.conversation_id;
    // The root is still present here. Explicitly exclude it from end-state/supersession queries.
    this.db
      .query(`UPDATE requests SET superseded=0 WHERE id=(SELECT id FROM requests
      WHERE conversation_id=? AND parent_id IS ? AND retry_input_chain IS ? AND previous_response_id IS ? AND thread_key IS ? AND id!=?
      ORDER BY turn_index DESC LIMIT 1)`)
      .run(cid, row.parent_id, row.retry_input_chain, row.previous_response_id, row.thread_key, id);
    this.db
      .query(
        `UPDATE conversations SET own_turns=own_turns-1,input_tokens=input_tokens-?,output_tokens=output_tokens-?,known_charge=known_charge-?,unknown_charge=unknown_charge-?,error_turns=error_turns-?,partial_turns=partial_turns-? WHERE id=?`,
      )
      .run(
        row.input_tokens ?? 0,
        row.output_tokens ?? 0,
        row.charge_quota ?? 0,
        row.charge_quota === null ? 1 : 0,
        row.completeness === 'error' ? 1 : 0,
        row.completeness === 'partial' ? 1 : 0,
        cid,
      );
    this.db
      .query('UPDATE conversation_models SET turns=turns-1 WHERE conversation_id=? AND model=?')
      .run(cid, row.model);
    this.db.query('DELETE FROM conversation_models WHERE conversation_id=? AND turns=0').run(cid);
    const c = this.db
      .query<Conversation & { own_turns: number }, [number]>(
        'SELECT * FROM conversations WHERE id=?',
      )
      .get(cid)!;
    if (!c.own_turns) {
      this.db.query('DELETE FROM conversations WHERE id=?').run(cid);
      if (c.forked_from_conversation !== null)
        this.db
          .query('UPDATE conversations SET branch_count=max(0,branch_count-1) WHERE id=?')
          .run(c.forked_from_conversation);
      this.pruneThread(c.thread_key);
    } else {
      this.db
        .query(
          'UPDATE conversations SET first_at=(SELECT min(received_at) FROM requests WHERE conversation_id=? AND id!=?),last_at=(SELECT max(received_at) FROM requests WHERE conversation_id=? AND id!=?) WHERE id=?',
        )
        .run(cid, id, cid, id, cid);
      this.refreshFlags(cid, id);
    }
  }
}

/** Verify and index in a temporary database first; publish only synchronous SQL atomically. */
export function backfillConversations(db: Database, restore: (id: number) => Uint8Array) {
  const staged = new Database(':memory:');
  try {
    staged.exec(
      'CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,received_at INTEGER,source TEXT,model TEXT,usage_json TEXT,cost_json TEXT)',
    );
    installConversationSchema(staged);
    const index = new ConversationIndex(staged);
    for (const row of db
      .query<IndexMeta & { id: number }, []>(
        'SELECT id,received_at,source,model,usage_json,cost_json FROM requests ORDER BY received_at,id',
      )
      .iterate()) {
      const envelope = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(restore(row.id)),
      ) as Envelope;
      const normalized = normalizeEnvelope(envelope);
      const prepared = index.prepare(normalized, row);
      staged
        .query(
          'INSERT INTO requests(id,received_at,source,model,usage_json,cost_json) VALUES(?,?,?,?,?,?)',
        )
        .run(row.id, row.received_at, row.source, row.model, row.usage_json, row.cost_json);
      staged.transaction(() => index.insert(row.id, row, prepared)).immediate();
    }
    db.transaction(() => {
      installConversationSchema(db);
      db.exec('DELETE FROM conversation_models; DELETE FROM threads; DELETE FROM conversations;');
      const cols = Object.keys(requestIndexColumns);
      for (const row of staged
        .query<Record<string, SQLQueryBindings>, []>('SELECT * FROM requests')
        .iterate())
        db.query(`UPDATE requests SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(
          ...cols.map((c) => row[c]),
          row.id,
        );
      for (const table of ['conversations', 'threads', 'conversation_models']) {
        for (const row of staged
          .query<Record<string, SQLQueryBindings>, []>(`SELECT * FROM ${table}`)
          .iterate()) {
          const columns = Object.keys(row);
          db.query(
            `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          ).run(...Object.values(row));
        }
      }
      db.exec('PRAGMA user_version=4');
    }).immediate();
  } finally {
    staged.close();
  }
}
