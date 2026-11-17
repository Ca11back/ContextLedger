import { object } from '../../contracts';
import { hash } from '../codec';
import type { MessageKind, NormalizedMessage, NormalizedPart } from './types';

export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const string = (value: unknown): string => (typeof value === 'string' ? value : '');
export const label = (value: unknown): string | undefined => {
  const s = string(value);
  // Never leave a dangling high surrogate in a bounded label.
  return s ? s.slice(0, /[\uD800-\uDBFF]/.test(s[127] ?? '') ? 127 : 128) : undefined;
};
/** Sort object keys only: arrays and user payload keys (including __proto__) are data. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, item) => {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          );
        }
        return item;
      },
      2,
    ) ?? 'null'
  );
}
export function part(value: unknown): NormalizedPart {
  return typeof value === 'string'
    ? { kind: 'text', text: value }
    : { kind: 'json', text: canonicalJson(value) };
}
export function message(
  kind: MessageKind,
  projection: unknown,
  values: unknown[] = [],
  fields: { role?: unknown; name?: unknown; callId?: unknown; media?: unknown } = {},
  completed = true,
): NormalizedMessage {
  const parts = values.map(part);
  return {
    side: 'input',
    index: 0,
    kind,
    role: label(fields.role),
    name: label(fields.name),
    callId: label(fields.callId),
    ...(fields.media === undefined ? {} : { media: { label: label(fields.media) ?? 'media' } }),
    parts,
    itemHash: hash(canonicalJson(projection)),
    completed,
    evidence:
      completed &&
      (kind === 'assistant' || kind === 'tool_call' || kind === 'refusal') &&
      parts.some((p) => p.text.length > 0),
  };
}
export function roleKind(role: unknown): MessageKind {
  return role === 'system' || role === 'developer'
    ? 'system'
    : role === 'user'
      ? 'user'
      : role === 'assistant' || role === 'model'
        ? 'assistant'
        : role === 'tool' || role === 'function'
          ? 'tool_result'
          : 'other';
}
export interface AdapterResult {
  input: NormalizedMessage[];
  output: NormalizedMessage[];
  terminal: boolean;
  invalid?: boolean;
  responseId?: string;
  stopReason?: string;
}
export interface CapturedEvent {
  type: string;
  data: Record<string, unknown>;
}
export function capturedEvents(value: unknown): CapturedEvent[] {
  return array(value).map((event) => {
    const wrapper = object(event);
    let data = wrapper.data ?? wrapper;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = { type: wrapper.event, unparsed: data };
      }
    }
    const record = object(data);
    return { type: string(record.type) || string(wrapper.event), data: record };
  });
}
export function chainHashes(
  messages: readonly NormalizedMessage[],
  initial = 'cl-chain-v1',
): string[] {
  let current = initial;
  return messages.map((m) => {
    current = hash(current + m.itemHash);
    return current;
  });
}
export function knownTextPart(value: unknown): unknown {
  const p = object(value);
  if (
    p.type === 'input_text' ||
    p.type === 'output_text' ||
    p.type === 'text' ||
    p.type === 'summary_text'
  )
    return { type: 'text', text: p.text };
  if (p.type === 'refusal') return { type: 'refusal', refusal: p.refusal };
  return value;
}
export function contentValues(content: unknown): unknown[] {
  if (typeof content === 'string') return [content];
  return array(content).flatMap((value): unknown[] => {
    const p = object(value);
    if (['input_text', 'output_text', 'text', 'summary_text'].includes(string(p.type)))
      return [p.text ?? ''];
    if (p.type === 'refusal') return [p.refusal ?? ''];
    return mediaDisplay(value)?.values ?? [value];
  });
}
export function contentProjection(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return array(content).map(knownTextPart);
}

/** Gateway media descriptions are labels only; never resolve or fetch their URLs. */
export function mediaDisplay(
  value: unknown,
  format?: 'gemini',
): { label: string; values: string[] } | undefined {
  const p = object(value);
  const type = string(p.type);
  const inline = object(p.inlineData),
    file = object(p.fileData);
  const mime = string(inline.mimeType || file.mimeType);
  const mediaLabel = ['input_image', 'image_url', 'image'].includes(type)
    ? '图片'
    : ['input_audio', 'audio'].includes(type)
      ? '音频'
      : ['input_file', 'file', 'document'].includes(type)
        ? '文件'
        : format === 'gemini' && (p.inlineData || p.fileData)
          ? mime.startsWith('image/')
            ? '图片'
            : mime.startsWith('audio/')
              ? '音频'
              : '文件'
          : undefined;
  if (!mediaLabel) return undefined;
  const url = [
    p.image_url,
    object(p.image_url).url,
    object(p.source).url,
    p.file_url,
    file.fileUri,
  ].find((v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v));
  return { label: mediaLabel, values: [`[${mediaLabel}]`, ...(url ? [url] : [])] };
}
export function contentMedia(content: unknown): string | undefined {
  for (const value of array(content)) {
    const media = mediaDisplay(value);
    if (media) return media.label;
  }
  return undefined;
}
export function knownAssistantContent(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0;
  return array(content).some((value) => {
    const p = object(value);
    return (
      (['input_text', 'output_text', 'text'].includes(string(p.type)) &&
        string(p.text).length > 0) ||
      (p.type === 'refusal' && string(p.refusal).length > 0)
    );
  });
}
