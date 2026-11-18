import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Envelope, object, type RecordMeta } from '../contracts';
import type {
  Completeness,
  ConversationDetail,
  ConversationList,
  ConversationRow,
  Fragment,
  FragmentPage,
  RequestList,
  RequestRow,
  SearchSummary,
  TextChunk,
  TurnList,
  TurnSummary,
} from '../conversation-contracts';
import { API_RESPONSE_MAX_BYTES, TEXT_CHUNK_CHARS } from '../conversation-contracts';
import { LedgerError } from './errors';
import { adminHttp } from './http';
import { normalizeEnvelope } from './normalize';
import type { NormalizedMessage } from './normalize/types';
import { safeEnd, splitsSurrogate } from './record-view';
import type { Statistics } from './statistics';
import type { Ledger } from './storage';

const CONTENT_BUDGET = API_RESPONSE_MAX_BYTES - 2048;
type Args = (string | number | null)[];
interface RequestDb extends RecordMeta, Statistics {
  protocol: string;
  completeness: Completeness;
  input_tokens: number | null;
  output_tokens: number | null;
  charge_quota: number | null;
  conversation_id: number | null;
  turn_index: number | null;
  link_rule: TurnSummary['linkRule'];
  parent_id: number | null;
  context_reset: TurnSummary['contextReset'];
  evidence_count: number;
  parent_coverage: number;
  stop_reason: string | null;
  retry_of_turn: number | null;
  superseded: number;
  incomplete_reason: TurnSummary['incompleteReason'];
  search_summary: string | null;
}
interface ConversationDb extends Statistics {
  id: number;
  title: string;
  first_at: number;
  last_at: number;
  own_turns: number;
  inherited_turns: number;
  models: string;
  more_models: number;
  input_tokens: number | null;
  output_tokens: number | null;
  charge_quota: number | null;
  charge_partial: number;
  has_error: number;
  has_partial: number;
  forked_from_conversation: number | null;
  forked_from_turn: number | null;
  branch_count: number;
  subagent_of: number | null;
  agent_name: string | null;
  subagent_kind: string | null;
  subagent_count: number;
  user_label: string | null;
  token_label: string | null;
  search_count: number;
}
const requestColumns = `id,received_at,source,host_request_id,model,user_label,token_label,truncated,media,duration_ms,
  protocol,completeness,input_tokens,output_tokens,charge_quota,cache_read_tokens,cache_write_tokens,input_total_tokens,charge_usd,conversation_id,turn_index,link_rule,parent_id,
  context_reset,evidence_count,parent_coverage,stop_reason,retry_of_turn,superseded,incomplete_reason,search_summary`;
const conversationSelect = `SELECT c.*, t.subagent_of, t.agent_name, t.subagent_kind,
  CASE WHEN c.id=t.primary_conversation_id THEN coalesce(t.subagent_count,0) ELSE 0 END AS subagent_count,
  (SELECT user_label FROM requests WHERE conversation_id=c.id ORDER BY turn_index LIMIT 1) AS user_label,
  (SELECT token_label FROM requests WHERE conversation_id=c.id ORDER BY turn_index LIMIT 1) AS token_label
  FROM conversations c LEFT JOIN threads t ON t.thread_key=c.thread_key`;
function bad(code = 'invalid_filter'): never {
  throw new LedgerError(400, code);
}
function integer(value: string | null, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || value.length > 16) bad();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) bad();
  return result;
}
function id(value: string) {
  return integer(value, 0, 1);
}
function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}
export function boundedJson(value: unknown) {
  if (bytes(value) > API_RESPONSE_MAX_BYTES) throw new LedgerError(413, 'response_too_large');
  return value;
}
function cap(value: string, limit = 128) {
  return value.slice(0, safeEnd(value, limit));
}
function existingConversation(store: Ledger, value: number): ConversationDb {
  const row = store.db
    .query<ConversationDb, [number]>(`${conversationSelect} WHERE c.id=?`)
    .get(value);
  if (!row) throw new LedgerError(404, 'conversation_not_found');
  return row;
}
function existingRequest(store: Ledger, value: number): RequestDb {
  const row = store.db
    .query<RequestDb, [number]>(`SELECT ${requestColumns} FROM requests WHERE id=?`)
    .get(value);
  if (!row) throw new LedgerError(404, 'record_not_found');
  return row;
}
function title(store: Ledger, value: number): string | null {
  return (
    store.db
      .query<{ title: string }, [number]>('SELECT title FROM conversations WHERE id=?')
      .get(value)?.title ?? null
  );
}
function rowView(store: Ledger, row: ConversationDb): ConversationRow {
  return {
    ...statisticsView(row),
    id: row.id,
    title: cap(row.title, 120),
    user: cap(row.user_label ?? '', 256),
    token: cap(row.token_label ?? '', 256),
    models: (JSON.parse(row.models) as string[]).slice(0, 4).map((m) => cap(m, 256)),
    moreModels: !!row.more_models,
    ownTurns: row.own_turns,
    inheritedTurns: row.inherited_turns,
    firstAt: row.first_at,
    lastAt: row.last_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    charge: row.charge_quota,
    chargePartial: !!row.charge_partial,
    hasError: !!row.has_error,
    hasPartial: !!row.has_partial,
    forkedFrom:
      row.forked_from_conversation === null
        ? null
        : { id: row.forked_from_conversation, turn: row.forked_from_turn! },
    branchCount: row.branch_count,
    subagentOf:
      row.subagent_of === null
        ? null
        : { id: row.subagent_of, title: title(store, row.subagent_of) ?? '来源已被容量清理删除' },
    agentName: row.agent_name,
    subagentKind: row.subagent_kind,
    subagentCount: row.subagent_count,
    searchCount: row.search_count,
  };
}
function turnView(row: RequestDb): TurnSummary {
  return {
    ...statisticsView(row),
    turnIndex: row.turn_index!,
    recordId: row.id,
    requestId: row.host_request_id,
    receivedAt: row.received_at,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    charge: row.charge_quota,
    durationMs: row.duration_ms,
    completeness: row.completeness,
    incompleteReason: row.incomplete_reason,
    linkRule: row.link_rule,
    parentOutputIncomplete: row.link_rule === 'prefix_partial',
    contextReset: row.context_reset,
    media: !!row.media,
    stopReason: row.stop_reason,
    retryOf: row.retry_of_turn,
    superseded: !!row.superseded,
  };
}
function requestView(store: Ledger, row: RequestDb): RequestRow {
  const search = searchSummary(row.search_summary);
  // One indexed lookup per search row, bounded by the list's maximum of 50 rows.
  const linked = search
    ? store.db
        .query<{ conversationId: number; turnIndex: number }, [number]>(
          `SELECT r.conversation_id AS conversationId,r.turn_index AS turnIndex
           FROM search_links l JOIN requests r ON r.id=l.consumer_record_id
           WHERE l.search_record_id=?`,
        )
        .get(row.id)
    : null;
  return {
    ...statisticsView(row),
    recordId: row.id,
    requestId: row.host_request_id,
    receivedAt: row.received_at,
    source: row.source,
    user: row.user_label,
    token: row.token_label,
    model: row.model,
    protocol: row.protocol,
    completeness: row.completeness,
    incompleteReason: row.incomplete_reason,
    truncated: !!row.truncated,
    media: !!row.media,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    charge: row.charge_quota,
    conversationId: row.conversation_id,
    turnIndex: row.turn_index,
    search: search ? { ...search, linked: linked ?? null } : null,
  };
}
function searchSummary(value: string | null): Omit<SearchSummary, 'recordId'> | null {
  return value === null ? null : JSON.parse(value);
}
function messageSearches(store: Ledger, recordId: number, itemIndex: number): SearchSummary[] {
  const result: SearchSummary[] = [];
  const rows = store.db
    .query<{ id: number; search_summary: string }, [number, number]>(
      `SELECT r.id,r.search_summary FROM search_links l
       JOIN requests r ON r.id=l.search_record_id
       WHERE l.consumer_record_id=? AND l.item_index=? ORDER BY l.part_index`,
    )
    .iterate(recordId, itemIndex);
  for (const row of rows) {
    const summary = searchSummary(row.search_summary);
    if (summary) result.push({ recordId: row.id, ...summary });
    // Stop reading once a single message header cannot fit; never silently drop a search.
    if (bytes(result) > CONTENT_BUDGET) throw new LedgerError(413, 'response_too_large');
  }
  return result;
}
function statisticsView(row: Statistics) {
  return {
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    inputTotalTokens: row.input_total_tokens,
    chargeUsd: row.charge_usd,
  };
}
// Authenticated opaque tokens contain only positions and scope, never evidence. Their signature
// survives process restarts and makes changing a record, conversation or UTF-16 offset invalid.
function signature(store: Ledger, body: string) {
  return createHmac('sha256', store.config.adminPassword)
    .update(`cl-page-v1:${body}`)
    .digest('base64url');
}
function encode(store: Ledger, scope: string, position: unknown): string {
  const body = Buffer.from(JSON.stringify([scope, position])).toString('base64url');
  return `${body}.${signature(store, body)}`;
}
function decode<T>(store: Ledger, token: string, scope: string): T {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) bad('invalid_cursor');
  const [body, mac] = token.split('.') as [string, string];
  const expected = Buffer.from(signature(store, body));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    bad('invalid_cursor');
  let result: unknown;
  try {
    result = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    bad('invalid_cursor');
  }
  if (!Array.isArray(result) || result.length !== 2 || result[0] !== scope) bad('invalid_cursor');
  return result[1] as T;
}
function numbers(value: unknown, count: number): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    bad('invalid_cursor');
}
function filters(params: URLSearchParams, conversation: boolean) {
  const where: string[] = [];
  const args: Args = [];
  const scope: string[] = [];
  for (const key of ['request', 'user', 'token', 'model', 'status', 'kind', 'from', 'to']) {
    const value = params.get(key);
    if (value === null) continue;
    if (value.length === 0 || value.length > 512) bad();
    if (key === 'request' && conversation) bad();
    scope.push(key, value);
    if (key === 'kind') {
      if (!conversation || !['main', 'subagent', 'all'].includes(value)) bad();
      if (value !== 'all') where.push(`t.subagent_of IS ${value === 'main' ? '' : 'NOT '}NULL`);
    } else if (key === 'from' || key === 'to') {
      const number = integer(value, 0);
      where.push(
        `${conversation ? (key === 'from' ? 'c.last_at' : 'c.first_at') : 'r.received_at'} ${key === 'from' ? '>=' : '<='} ?`,
      );
      args.push(number);
    } else if (key === 'status') {
      if (!['complete', 'partial', 'error', 'media'].includes(value)) bad();
      if (value === 'media') {
        where.push(
          conversation
            ? 'EXISTS(SELECT 1 FROM requests f WHERE f.conversation_id=c.id AND f.media=1)'
            : 'r.media=1',
        );
        continue;
      }
      if (conversation && (value === 'error' || value === 'partial')) {
        where.push(value === 'error' ? 'c.has_error=1' : 'c.has_partial=1');
      } else {
        if (conversation)
          where.push(
            'EXISTS(SELECT 1 FROM requests f WHERE f.conversation_id=c.id AND f.completeness=?)',
          );
        else where.push('r.completeness=?');
        args.push(value);
      }
    } else {
      const column = {
        request: 'host_request_id',
        user: 'user_label',
        token: 'token_label',
        model: 'model',
      }[key]!;
      if (conversation)
        where.push(
          `EXISTS(SELECT 1 FROM requests f WHERE f.conversation_id=c.id AND f.${column}=?)`,
        );
      else where.push(`r.${column}=?`);
      args.push(value);
    }
  }
  if (
    params.has('from') &&
    params.has('to') &&
    Number(params.get('from')) > Number(params.get('to'))
  )
    bad();
  return { where, args, scope: JSON.stringify(scope) };
}
function page<T, R>(
  store: Ledger,
  rows: T[],
  limit: number,
  scope: string,
  project: (item: T) => R,
  position: (item: T) => unknown,
) {
  const accepted: R[] = [];
  let cursor: string | null = null;
  for (const row of rows.slice(0, limit)) {
    const next = project(row);
    accepted.push(next);
    if (bytes(accepted) > CONTENT_BUDGET) {
      accepted.pop();
      break;
    }
    cursor = encode(store, scope, position(row));
  }
  if (!accepted.length && rows.length) throw new LedgerError(413, 'response_too_large');
  if (accepted.length === rows.length) cursor = null;
  return { rows: accepted, cursor };
}
export function conversations(store: Ledger, params: URLSearchParams): ConversationList {
  const { where, args, scope: filter } = filters(params, true);
  const sort = params.get('sort') ?? 'recent';
  if (sort !== 'recent' && sort !== 'cost') bad();
  // Preserve the existing/default recent scope across upgrades.
  const scope = sort === 'recent' ? `conversations:${filter}` : `conversations:cost:${filter}`;
  const limit = integer(params.get('limit'), 50, 1, 50);
  if (params.has('cursor')) {
    const pos = decode<unknown>(store, params.get('cursor')!, scope);
    if (sort === 'cost') {
      if (
        !Array.isArray(pos) ||
        pos.length !== 2 ||
        (pos[0] !== null && (typeof pos[0] !== 'number' || !Number.isFinite(pos[0]))) ||
        !Number.isSafeInteger(pos[1]) ||
        pos[1] < 1
      )
        bad('invalid_cursor');
      existingConversation(store, pos[1]);
      if (pos[0] === null) {
        where.push('(c.charge_quota IS NULL AND c.id<?)');
        args.push(pos[1]);
      } else {
        where.push('(c.charge_quota<? OR (c.charge_quota=? AND c.id<?) OR c.charge_quota IS NULL)');
        args.push(pos[0], pos[0], pos[1]);
      }
    } else {
      numbers(pos, 2);
      existingConversation(store, pos[1]!);
      where.push('(c.last_at<? OR (c.last_at=? AND c.id<?))');
      args.push(pos[0]!, pos[0]!, pos[1]!);
    }
  }
  const order =
    sort === 'cost' ? 'c.charge_quota DESC NULLS LAST,c.id DESC' : 'c.last_at DESC,c.id DESC';
  const rows = store.db
    .query<ConversationDb, Args>(
      `${conversationSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`,
    )
    .all(...args, limit + 1);
  return page(
    store,
    rows,
    limit,
    scope,
    (r) => rowView(store, r),
    (r) => [sort === 'cost' ? r.charge_quota : r.last_at, r.id],
  );
}
export function requests(store: Ledger, params: URLSearchParams): RequestList {
  const { where, args, scope: filter } = filters(params, false);
  const scope = `requests:${filter}`;
  const limit = integer(params.get('limit'), 50, 1, 50);
  if (params.has('cursor')) {
    const pos = decode<unknown>(store, params.get('cursor')!, scope);
    numbers(pos, 2);
    existingRequest(store, pos[1]!);
    where.push('(r.received_at<? OR (r.received_at=? AND r.id<?))');
    args.push(pos[0]!, pos[0]!, pos[1]!);
  }
  const rows = store.db
    .query<RequestDb, Args>(
      `SELECT ${requestColumns
        .split(',')
        .map((c) => `r.${c.trim()}`)
        .join(
          ',',
        )} FROM requests r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.received_at DESC,r.id DESC LIMIT ?`,
    )
    .all(...args, limit + 1);
  return page(
    store,
    rows,
    limit,
    scope,
    (r) => requestView(store, r),
    (r) => [r.received_at, r.id],
  );
}
export function requestDetail(store: Ledger, recordId: number): RequestRow {
  return boundedJson(requestView(store, existingRequest(store, recordId))) as RequestRow;
}
export function lookup(store: Ledger, params: URLSearchParams) {
  const q = params.get('q');
  if (q === null || q.length === 0 || q.length > 512) bad();
  const candidates = store.db
    .query<RequestDb, [string]>(
      `SELECT ${requestColumns} FROM requests WHERE host_request_id=? ORDER BY received_at DESC,id DESC LIMIT 10`,
    )
    .all(q)
    .map((r) => ({
      recordId: r.id,
      conversationId: r.conversation_id,
      turnIndex: r.turn_index,
      source: r.source,
      receivedAt: r.received_at,
    }));
  return { candidates };
}
export function relations(
  store: Ledger,
  conversationId: number,
  params: URLSearchParams,
  kind: 'branches' | 'subagents',
) {
  existingConversation(store, conversationId);
  const scope = `${kind}:${conversationId}`;
  const limit = integer(params.get('limit'), 50, 1, 50);
  const args: Args = [conversationId];
  let cursorWhere = '';
  if (params.has('cursor')) {
    const p = decode<unknown>(store, params.get('cursor')!, scope);
    numbers(p, 1);
    existingConversation(store, p[0]!);
    cursorWhere = ' AND c.id>?';
    args.push(p[0]!);
  }
  const condition =
    kind === 'branches'
      ? 'c.forked_from_conversation=?'
      : 't.subagent_of=? AND c.id=t.primary_conversation_id';
  const rows = store.db
    .query<ConversationDb, Args>(
      `${conversationSelect} WHERE ${condition}${cursorWhere} ORDER BY c.id LIMIT ?`,
    )
    .all(...args, limit + 1);
  return page(
    store,
    rows,
    limit,
    scope,
    (r) => rowView(store, r),
    (r) => [r.id],
  );
}
export function conversationDetail(store: Ledger, conversationId: number): ConversationDetail {
  const row = existingConversation(store, conversationId);
  const conversation = rowView(store, row);
  const branches = relations(
    store,
    conversationId,
    new URLSearchParams({ limit: '20' }),
    'branches',
  ).rows;
  const subagents = relations(
    store,
    conversationId,
    new URLSearchParams({ limit: '20' }),
    'subagents',
  ).rows;
  const forkTitle =
    row.forked_from_conversation === null ? null : title(store, row.forked_from_conversation);
  const forkExists =
    row.forked_from_conversation !== null &&
    !!store.db
      .query('SELECT id FROM requests WHERE conversation_id=? AND turn_index=?')
      .get(row.forked_from_conversation, row.forked_from_turn);
  const parentTitle = row.subagent_of === null ? null : title(store, row.subagent_of);
  const result: ConversationDetail = {
    conversation,
    forkedFrom:
      row.forked_from_conversation === null
        ? null
        : {
            id: row.forked_from_conversation,
            turn: row.forked_from_turn!,
            title: forkTitle,
            removed: !forkExists,
          },
    branchesPreview: branches.map((r) => ({
      atTurn: r.forkedFrom!.turn,
      id: r.id,
      title: r.title,
    })),
    branchCount: row.branch_count,
    subagentOf:
      row.subagent_of === null
        ? null
        : { id: row.subagent_of, title: parentTitle, removed: parentTitle === null },
    subagentsPreview: subagents.map((r) => ({ id: r.id, title: r.title, agentName: r.agentName })),
    subagentCount: row.subagent_count,
    lastTurnIndex:
      store.db
        .query<{ last: number | null }, [number]>(
          'SELECT max(turn_index) AS last FROM requests WHERE conversation_id=?',
        )
        .get(conversationId)?.last ?? null,
  };
  while (
    bytes(result) > CONTENT_BUDGET &&
    (result.branchesPreview.length || result.subagentsPreview.length)
  ) {
    if (result.branchesPreview.length >= result.subagentsPreview.length)
      result.branchesPreview.pop();
    else result.subagentsPreview.pop();
  }
  return boundedJson(result) as ConversationDetail;
}
function start(store: Ledger, conversationId: number, params: URLSearchParams) {
  existingConversation(store, conversationId);
  if (params.has('cursor') && (params.has('startTurn') || params.has('fromTurn'))) bad();
  if (params.has('startTurn') && params.has('fromTurn')) bad();
  // fromTurn: the first existing turn at or after n (retention can leave gaps); no 404.
  if (params.has('fromTurn')) return integer(params.get('fromTurn'), 0, 1);
  if (!params.has('startTurn')) return 0;
  const turn = integer(params.get('startTurn'), 0, 1);
  if (
    !store.db
      .query('SELECT id FROM requests WHERE conversation_id=? AND turn_index=?')
      .get(conversationId, turn)
  )
    throw new LedgerError(404, 'turn_not_found');
  return turn;
}
export function turns(store: Ledger, conversationId: number, params: URLSearchParams): TurnList {
  let after = start(store, conversationId, params);
  const scope = `turns:${conversationId}`;
  let inclusive = after !== 0;
  const limit = integer(params.get('limit'), 50, 1, 100);
  if (params.has('cursor')) {
    const p = decode<unknown>(store, params.get('cursor')!, scope);
    numbers(p, 2);
    const record = existingRequest(store, p[1]!);
    if (record.conversation_id !== conversationId || record.turn_index !== p[0])
      bad('invalid_cursor');
    after = p[0]!;
    inclusive = false;
  }
  const rows = store.db
    .query<RequestDb, [number, number, number]>(
      `SELECT ${requestColumns} FROM requests WHERE conversation_id=? AND turn_index${inclusive ? '>=' : '>'}? ORDER BY turn_index LIMIT ?`,
    )
    .all(conversationId, after, limit + 1);
  const result = page(store, rows, limit, scope, turnView, (r) => [r.turn_index, r.id]);
  return { turns: result.rows, cursor: result.cursor };
}
interface DisplayMessage {
  message: NormalizedMessage;
  leadingHistory: boolean;
}
function messages(store: Ledger, row: RequestDb): DisplayMessage[] {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(store.restore(row.id)));
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError(500, 'invalid_stored_json');
  }
  const normalized = normalizeEnvelope(envelope);
  const coverage = row.parent_coverage ?? 0;
  return [
    ...normalized.input.slice(coverage).map((message) => ({
      message,
      leadingHistory: row.parent_id === null && message.index < normalized.leadingHistoryCount,
    })),
    ...normalized.output.map((message) => ({ message, leadingHistory: false })),
  ];
}
function messageId(row: RequestDb, message: NormalizedMessage) {
  return `${row.id}:${message.side}:${message.index}`;
}
type TextPosition = [number, 'input' | 'output', number, number, number];
function textChunk(
  store: Ledger,
  row: RequestDb,
  message: NormalizedMessage,
  partIndex: number,
  offset: number,
  maxBytes = CONTENT_BUDGET,
): TextChunk {
  const part = message.parts[partIndex];
  if (!part) bad('invalid_continuation');
  if (offset > part.text.length || splitsSurrogate(part.text, offset)) bad('invalid_continuation');
  const result: TextChunk = {
    messageId: messageId(row, message),
    partIndex,
    offset,
    text: '',
    nextOffset: null,
    partTotal: part.text.length,
    continuation: null,
  };
  const setEnd = (end: number) => {
    result.text = part.text.slice(offset, end);
    result.nextOffset = end < part.text.length ? end : null;
    result.continuation =
      result.nextOffset === null
        ? null
        : encode(store, 'text', [
            row.id,
            message.side,
            message.index,
            partIndex,
            end,
          ] satisfies TextPosition);
  };
  let low = offset,
    high = Math.min(part.text.length, offset + TEXT_CHUNK_CHARS);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    setEnd(safeEnd(part.text, middle));
    if (bytes(result) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const end = safeEnd(part.text, low);
  setEnd(end);
  if ((end === offset && offset < part.text.length) || bytes(result) > maxBytes)
    throw new LedgerError(413, 'response_too_large');
  return result;
}
export function textContinuation(store: Ledger, token: string): TextChunk {
  const p = decode<unknown>(store, token, 'text');
  if (!Array.isArray(p) || p.length !== 5 || !['input', 'output'].includes(p[1]))
    bad('invalid_continuation');
  for (const index of [0, 2, 3, 4])
    if (!Number.isSafeInteger(p[index]) || p[index] < 0) bad('invalid_continuation');
  const [recordId, side, index, part, offset] = p as TextPosition;
  const row = existingRequest(store, recordId);
  const message = messages(store, row).find(
    (m) => m.message.side === side && m.message.index === index,
  )?.message;
  if (!message) throw new LedgerError(404, 'message_not_found');
  return textChunk(store, row, message, part, offset);
}
// Cursor position describes the NEXT descriptor. stage: 0 reset, 1 turn,
// 2 message header, 3 first part chunk. A chunk always advances to the next part.
type FragmentPosition = [number, number, number, number, number]; // record,turn,stage,message,part
export function fragments(
  store: Ledger,
  conversationId: number,
  params: URLSearchParams,
): FragmentPage {
  const first = start(store, conversationId, params);
  const scope = `fragments:${conversationId}`;
  let position: FragmentPosition | undefined;
  if (params.has('cursor')) {
    const p = decode<unknown>(store, params.get('cursor')!, scope);
    numbers(p, 5);
    const row = existingRequest(store, p[0]!);
    if (row.conversation_id !== conversationId || row.turn_index !== p[1]) bad('invalid_cursor');
    if (p[2]! > 3) bad('invalid_cursor');
    position = p as FragmentPosition;
  }
  const result: FragmentPage = { fragments: [], cursor: null };
  const rows = store.db
    .query<RequestDb, [number, number]>(
      `SELECT ${requestColumns} FROM requests WHERE conversation_id=? AND turn_index>=? ORDER BY turn_index`,
    )
    .iterate(conversationId, position?.[1] ?? first);
  for (const row of rows) {
    let stage = position?.[0] === row.id ? position[2] : 0;
    let mi = position?.[0] === row.id ? position[3] : 0;
    let pi = position?.[0] === row.id ? position[4] : 0;
    const list = messages(store, row);
    while (true) {
      let fragment: Fragment;
      let nextStage = stage,
        nextMi = mi,
        nextPi = pi;
      if (stage === 0) {
        if (!row.context_reset) {
          stage = 1;
          continue;
        }
        fragment = { type: 'reset', turnIndex: row.turn_index!, reason: row.context_reset };
        nextStage = 1;
      } else if (stage === 1) {
        fragment = { type: 'turn', turn: turnView(row) };
        nextStage = 2;
      } else {
        const entry = list[mi];
        if (!entry) break;
        const m = entry.message;
        if (stage === 2) {
          const searches =
            m.side === 'input' && m.kind === 'tool_result'
              ? messageSearches(store, row.id, m.index)
              : [];
          fragment = {
            type: 'message',
            messageId: messageId(row, m),
            turnIndex: row.turn_index!,
            side: m.side,
            kind: m.kind,
            ...(m.role === undefined ? {} : { role: cap(m.role) }),
            ...(m.name === undefined ? {} : { name: cap(m.name) }),
            ...(m.callId === undefined ? {} : { callId: cap(m.callId) }),
            ...(m.media ? { media: { label: cap(m.media.label) } } : {}),
            ...(m.alternatives === undefined ? {} : { alternatives: m.alternatives }),
            partCount: m.parts.length,
            ...(entry.leadingHistory ? { leadingHistory: true } : {}),
            ...(searches.length ? { searches } : {}),
          };
          nextStage = m.parts.length ? 3 : 2;
          if (!m.parts.length) nextMi++;
        } else {
          if (!m.parts[pi]) {
            mi++;
            pi = 0;
            stage = 2;
            continue;
          }
          const remaining = CONTENT_BUDGET - bytes(result) - 256;
          try {
            fragment = {
              type: 'chunk',
              partKind: m.parts[pi]!.kind,
              ...textChunk(store, row, m, pi, 0, remaining),
            };
          } catch (error) {
            if (error instanceof LedgerError && error.status === 413 && result.fragments.length) {
              result.cursor = encode(store, scope, [row.id, row.turn_index!, stage, mi, pi]);
              return result;
            }
            throw error;
          }
          nextPi++;
          if (nextPi === m.parts.length) {
            nextMi++;
            nextPi = 0;
            nextStage = 2;
          }
        }
      }
      result.fragments.push(fragment);
      if (bytes(result) > CONTENT_BUDGET) {
        result.fragments.pop();
        if (!result.fragments.length) throw new LedgerError(413, 'response_too_large');
        result.cursor = encode(store, scope, [row.id, row.turn_index!, stage, mi, pi]);
        return result;
      }
      stage = nextStage;
      mi = nextMi;
      pi = nextPi;
      // Descriptor count also bounds headers-only pages and CPU per HTTP call.
      if (result.fragments.length >= 200) {
        if (stage === 2 && mi >= list.length) break;
        result.cursor = encode(store, scope, [row.id, row.turn_index!, stage, mi, pi]);
        return result;
      }
    }
    position = undefined;
    if (result.fragments.length >= 200) {
      const next = store.db
        .query<RequestDb, [number, number]>(
          `SELECT ${requestColumns} FROM requests WHERE conversation_id=? AND turn_index>? ORDER BY turn_index LIMIT 1`,
        )
        .get(conversationId, row.turn_index!);
      result.cursor = next ? encode(store, scope, [next.id, next.turn_index!, 0, 0, 0]) : null;
      return result;
    }
  }
  return result;
}
export type ConversationEndpoint =
  | 'conversations'
  | 'detail'
  | 'branches'
  | 'subagents'
  | 'turns'
  | 'fragments'
  | 'text'
  | 'requests'
  | 'request'
  | 'lookup';
export function conversationHttp(
  request: Request,
  store: Ledger,
  endpoint: ConversationEndpoint,
  target?: string,
): Response {
  return adminHttp(request, store, () => {
    const params = new URL(request.url).searchParams;
    let result: unknown;
    switch (endpoint) {
      case 'conversations':
        result = conversations(store, params);
        break;
      case 'detail':
        result = conversationDetail(store, id(target ?? ''));
        break;
      case 'branches':
      case 'subagents':
        result = relations(store, id(target ?? ''), params, endpoint);
        break;
      case 'turns':
        result = turns(store, id(target ?? ''), params);
        break;
      case 'fragments':
        result = fragments(store, id(target ?? ''), params);
        break;
      case 'text':
        result = textContinuation(store, target ?? '');
        break;
      case 'requests':
        result = requests(store, params);
        break;
      case 'request':
        result = requestDetail(store, id(target ?? ''));
        break;
      case 'lookup':
        result = lookup(store, params);
        break;
    }
    return boundedJson(result);
  });
}

/** Active uploads are kept visible; only oldest terminal UI receipts are omitted. */
export function boundedUploads(value: { uploads: Record<string, unknown>[] }) {
  const ordered = [
    ...value.uploads.filter((row) => row.state === 'partial'),
    ...value.uploads.filter((row) => row.state !== 'partial'),
  ];
  const result = { uploads: [] as Record<string, unknown>[], omitted: 0 };
  for (const row of ordered) {
    const hint = object(row.hint),
      context = object(hint.context);
    const label = (v: unknown) => (typeof v === 'string' ? cap(v, 128) : '');
    result.uploads.push({
      ...row,
      hint: {
        request_id: label(hint.request_id),
        context: { format: label(context.format), model: label(context.model) },
      },
      hint_truncated: [hint.request_id, context.format, context.model].some(
        (v) => typeof v === 'string' && v.length > 128,
      ),
    });
    if (bytes(result) > CONTENT_BUDGET) {
      result.uploads.pop();
      break;
    }
  }
  result.omitted = ordered.length - result.uploads.length;
  return boundedJson(result) as typeof result;
}
