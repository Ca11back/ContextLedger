import {
  RECORD_VIEW_MAX_BYTES,
  RECORD_VIEW_MAX_DEPTH,
  RECORD_VIEW_MAX_ENTRIES,
  RECORD_VIEW_MAX_KEY_CHARS,
  RECORD_VIEW_MAX_PATH_CHARS,
  RECORD_VIEW_TEXT_CHARS,
  type RecordEntry,
  type RecordNode,
  type RecordSection,
  type RecordView,
} from '../view-contracts';
import { LedgerError } from './errors';
import { adminHttp } from './http';
import type { Ledger } from './storage';

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const PREVIEW_CHARS = 160;

function invalid(code: string): never {
  throw new LedgerError(400, code);
}

function integer(value: string | null, fallback: number, code: string): number {
  if (value === null) return fallback;
  if (value.length > 16 || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    invalid(code);
  return Number(value);
}

function parsePath(params: URLSearchParams): string[] {
  const value = params.get('path') ?? '[]';
  if (value.length > RECORD_VIEW_MAX_PATH_CHARS) invalid('view_path_too_large');
  let path: unknown;
  try {
    path = JSON.parse(value);
  } catch {
    invalid('invalid_view_path');
  }
  if (
    !Array.isArray(path) ||
    path.length > RECORD_VIEW_MAX_DEPTH ||
    path.some(
      (segment) => typeof segment !== 'string' || segment.length > RECORD_VIEW_MAX_KEY_CHARS,
    )
  ) {
    invalid('invalid_view_path');
  }
  return path;
}

function container(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

function has(value: unknown, key: string): boolean {
  return container(value) && Object.hasOwn(value, key);
}

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) invalid('invalid_array_index');
    const index = Number(key);
    if (!Number.isSafeInteger(index)) invalid('invalid_array_index');
    if (index >= value.length) throw new LedgerError(404, 'view_path_not_found');
    return value[index];
  }
  if (!has(value, key)) throw new LedgerError(404, 'view_path_not_found');
  return (value as Record<string, unknown>)[key];
}

function splitsSurrogate(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return false;
  const left = value.charCodeAt(offset - 1),
    right = value.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function safeEnd(value: string, end: number): number {
  return splitsSurrogate(value, end) ? end - 1 : end;
}

function preview(value: string): string {
  if (value.length <= PREVIEW_CHARS) return value;
  return `${value.slice(0, safeEnd(value, PREVIEW_CHARS - 1))}…`;
}

function describe(value: unknown, keys?: string[]): RecordNode {
  if (value === null) return { kind: 'null', preview: 'null', count: 0 };
  if (Array.isArray(value)) return { kind: 'array', preview: '', count: value.length };
  if (container(value))
    return { kind: 'object', preview: '', count: (keys ?? Object.keys(value)).length };
  if (typeof value === 'string')
    return { kind: 'string', preview: preview(value), count: value.length };
  if (typeof value === 'number') return { kind: 'number', preview: String(value), count: 0 };
  if (typeof value === 'boolean') return { kind: 'boolean', preview: String(value), count: 0 };
  throw new LedgerError(500, 'invalid_stored_json_value');
}

function sections(document: unknown): RecordSection[] {
  const result: RecordSection[] = [];
  const report = has(document, 'report') ? child(document, 'report') : null;
  if (has(report, 'request'))
    result.push({ id: 'request', label: '输入', path: ['report', 'request'] });
  if (has(report, 'response')) {
    const response = child(report, 'response');
    result.push({
      id: 'response',
      label: '输出',
      path: has(response, 'body') ? ['report', 'response', 'body'] : ['report', 'response'],
    });
    if (has(response, 'events'))
      result.push({ id: 'events', label: '事件', path: ['report', 'response', 'events'] });
  }
  if (has(document, 'capture'))
    result.push({ id: 'capture', label: '采集说明', path: ['capture'] });
  if (has(document, 'context')) result.push({ id: 'context', label: '上下文', path: ['context'] });
  result.push({ id: 'raw', label: '完整结构', path: [] });
  return result;
}

function bytes(view: RecordView): number {
  // Only the already bounded projection is serialized, never the stored subtree.
  return Buffer.byteLength(JSON.stringify(view));
}

function entry(key: string, value: unknown, path: string[]): RecordEntry {
  const result: RecordEntry = { key: previewKey(key), path: null, ...describe(value) };
  if (key.length > RECORD_VIEW_MAX_KEY_CHARS) result.unavailable = 'key_limit';
  else {
    const next = [...path, key];
    if (
      next.length > RECORD_VIEW_MAX_DEPTH ||
      JSON.stringify(next).length > RECORD_VIEW_MAX_PATH_CHARS
    ) {
      result.unavailable = 'path_limit';
    } else result.path = next;
  }
  return result;
}

function previewKey(key: string): string {
  if (key.length <= RECORD_VIEW_MAX_KEY_CHARS) return key;
  return `${key.slice(0, safeEnd(key, RECORD_VIEW_MAX_KEY_CHARS - 1))}…`;
}

/** Reconstruct and verify on demand. No request evidence is kept in a module-level cache. */
export function recordView(store: Ledger, id: number, params: URLSearchParams): RecordView {
  if (!Number.isSafeInteger(id) || id <= 0) invalid('invalid_id');
  const path = parsePath(params);
  const offset = integer(params.get('offset'), 0, 'invalid_view_offset');
  const limit = integer(params.get('limit'), 20, 'invalid_view_limit');
  if (limit < 1 || limit > RECORD_VIEW_MAX_ENTRIES) invalid('invalid_view_limit');
  const detail = store.detail(id);
  if (detail.meta.body_length > MAX_DOCUMENT_BYTES)
    throw new LedgerError(413, 'view_document_too_large');
  let document: unknown;
  try {
    document = JSON.parse(detail.received_json);
  } catch {
    throw new LedgerError(500, 'invalid_stored_json');
  }
  let value = document;
  for (const segment of path) value = child(value, segment);
  const keys = container(value) && !Array.isArray(value) ? Object.keys(value) : undefined;
  const node = describe(value, keys);
  if (offset > node.count || (typeof value === 'string' && splitsSurrogate(value, offset)))
    invalid('invalid_view_offset');
  const view: RecordView = {
    meta: detail.meta,
    path,
    node,
    entries: [],
    text: typeof value === 'string' ? '' : null,
    offset,
    nextOffset: null,
    total: node.count,
    sections: sections(document),
  };
  // Reserve the continuation number before budgeting, including at page boundaries.
  if (offset < node.count) view.nextOffset = Number.MAX_SAFE_INTEGER;
  if (bytes(view) > RECORD_VIEW_MAX_BYTES) throw new LedgerError(413, 'view_response_too_large');
  if (typeof value === 'string') {
    let low = offset,
      high = Math.min(value.length, offset + RECORD_VIEW_TEXT_CHARS);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      view.text = value.slice(offset, safeEnd(value, middle));
      if (bytes(view) <= RECORD_VIEW_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    const end = safeEnd(value, low);
    if (end === offset && offset < value.length)
      throw new LedgerError(413, 'view_response_too_large');
    view.text = value.slice(offset, end);
    view.nextOffset = end < value.length ? end : null;
  } else if (container(value)) {
    let cursor = offset;
    const end = Math.min(node.count, offset + limit);
    while (cursor < end) {
      const key = Array.isArray(value) ? String(cursor) : keys![cursor]!;
      const item = entry(key, child(value, key), path);
      view.entries.push(item);
      if (bytes(view) > RECORD_VIEW_MAX_BYTES) {
        view.entries.pop();
        if (!view.entries.length) throw new LedgerError(413, 'view_response_too_large');
        break;
      }
      cursor++;
    }
    view.nextOffset = cursor < node.count ? cursor : null;
  }
  return view;
}

export function recordViewHttp(request: Request, store: Ledger, id: string): Response {
  return adminHttp(request, store, () => {
    if (!/^[1-9]\d*$/.test(id)) invalid('invalid_id');
    return recordView(store, Number(id), new URL(request.url).searchParams);
  });
}
