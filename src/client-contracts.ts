import type { RecordMeta } from './contracts';

// This re-export is erased by TypeScript. Storage never enters the client graph.
export type { Metrics } from './server/storage';
export interface RecordList {
  rows: RecordMeta[];
  cursor: number | null;
}
export interface UploadState {
  upload_id: string;
  state: string;
  reason: string;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  record_id: number | null;
  envelope_bytes: number;
  missing_count: number;
  missing_bytes: number;
  hint: { request_id?: string; context?: { model?: string; format?: string } };
  hint_verified: false;
}
export interface UploadList {
  uploads: UploadState[];
}
