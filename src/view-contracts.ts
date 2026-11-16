import type { RecordMeta } from './contracts';

export const RECORD_VIEW_MAX_BYTES = 64 * 1024;
export const RECORD_VIEW_TEXT_CHARS = 8192;
export const RECORD_VIEW_MAX_DEPTH = 32;
export const RECORD_VIEW_MAX_PATH_CHARS = 8192;
export const RECORD_VIEW_MAX_KEY_CHARS = 512;
export const RECORD_VIEW_MAX_ENTRIES = 25;

export type RecordNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface RecordNode {
  kind: RecordNodeKind;
  /** Scalar-only preview, at most 160 UTF-16 code units. Containers have no preview. */
  preview: string;
  /** Immediate children for containers, UTF-16 length for strings, otherwise zero. */
  count: number;
}

export interface RecordEntry extends RecordNode {
  key: string;
  /** Null explicitly marks a key or depth that cannot be inspected through this API. */
  path: string[] | null;
  unavailable?: 'key_limit' | 'path_limit';
}

export interface RecordSection {
  id: 'request' | 'response' | 'capture' | 'context' | 'events' | 'raw';
  label: string;
  path: string[];
}

export interface RecordView {
  meta: RecordMeta;
  path: string[];
  node: RecordNode;
  entries: RecordEntry[];
  /** Exact decoded string chunk; null for other node kinds. */
  text: string | null;
  offset: number;
  /** Actual continuation, which can be shorter than the requested page to fit the byte budget. */
  nextOffset: number | null;
  total: number;
  sections: RecordSection[];
}
