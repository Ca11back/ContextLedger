export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
export const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
export interface RecordMeta {
  id: number;
  received_at: number;
  source: string;
  upload_id: string;
  host_request_id: string;
  model: string;
  channel: string;
  user_label: string;
  token_label: string;
  outcome: string;
  truncated: number;
  media: number;
  duration_ms: number | null;
  usage_json: string;
  cost_json: string;
  body_hash: string;
  body_length: number;
  storage_mode: 'item_cas' | 'whole_zstd';
}
export interface Envelope {
  version: 1;
  upload_id: string;
  source: string;
  context: JsonObject;
  report: JsonObject;
  capture?: JsonObject;
}
function label(value: unknown, limit = 256) {
  return text(value).slice(0, limit);
}
function numericProjection(value: unknown, keys: string[]) {
  const source = object(value);
  return Object.fromEntries(
    keys
      .filter((key) => typeof source[key] === 'number' && Number.isFinite(source[key]))
      .map((key) => [key, source[key]]),
  );
}
export function metadata(envelope: Envelope) {
  const r = envelope.report,
    c = envelope.context,
    response = object(r.response);
  return {
    host_request_id: label(r.requestId, 512),
    model: label(c.model),
    channel: label(object(c.channel).id ?? c.channel),
    user_label: label(object(r.user).username),
    token_label: label(object(r.token).name),
    outcome: r.error ? 'error' : Number(response.status) >= 400 ? 'error' : 'reported',
    truncated: response.truncated === true ? 1 : 0,
    media:
      Array.isArray(object(r.request).media) && (object(r.request).media as unknown[]).length
        ? 1
        : 0,
    duration_ms:
      typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : null,
    usage_json: JSON.stringify(
      r.usage == null
        ? null
        : numericProjection(r.usage, [
            'promptTokens',
            'completionTokens',
            'cacheTokens',
            'cacheWriteTokens',
            'cacheCreationTokens',
            'cacheCreationTokens5m',
            'cacheCreationTokens1h',
            'cacheCreationTokens12h',
            'inputTokensTotal',
            'totalTokens',
          ]),
    ),
    cost_json: JSON.stringify(r.cost == null ? null : numericProjection(r.cost, ['quota', 'usd'])),
  };
}
