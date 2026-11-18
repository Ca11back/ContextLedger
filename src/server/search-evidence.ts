import { type Envelope, object } from '../contracts';
import type { SearchOperation } from '../conversation-contracts';
import { hash } from './codec';
import { identityKey, isolationDomain } from './identity';
import type { NormalizedRequest } from './normalize';
import { array, capturedEvents } from './normalize/common';
import { responseItem } from './normalize/responses';

export type SearchProjection = {
  sessionKey: string | null;
  outputHash: string | null;
  operations: SearchOperation[];
  resultCount: number | null;
};
export type SearchToolKind = 'web' | 'exec';
export type SearchToolEvidence = {
  origins: { callId: string; kind: SearchToolKind | 'other' }[];
  parts: {
    itemIndex: number;
    partIndex: number;
    callId: string;
    kind: SearchToolKind;
    outputHash: string;
  }[];
};

function bounded(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    ? value
    : null;
}
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[199] ?? '') ? 199 : 200);
}
function operations(commands: unknown): SearchOperation[] {
  const result: SearchOperation[] = [];
  const kinds: Record<string, SearchOperation['kind']> = {
    search_query: 'search',
    literature_search_query: 'literature',
    image_query: 'image',
    open: 'open',
    click: 'click',
    find: 'find',
  };
  for (const [key, values] of Object.entries(object(commands))) {
    if (key === 'response_length') continue;
    const kind = Object.hasOwn(kinds, key) ? kinds[key]! : 'other';
    if (kind === 'click' || kind === 'find') {
      result.push({ kind, text: `${array(values).length} 次` });
    } else if (kind === 'other') {
      result.push({ kind, text: preview(`${key}: ${Array.isArray(values) ? values.length : 1}`) });
    } else {
      for (const value of array(values)) {
        const op = object(value);
        const text =
          kind === 'search' || kind === 'literature' || kind === 'image'
            ? preview(op.q)
            : preview(op.ref_id);
        result.push({ kind, text });
        if (result.length === 20) return result;
      }
    }
    if (result.length === 20) break;
  }
  return result;
}

/** Bounded summaries and exact hashes; no raw search text is retained in derived storage. */
export function projectSearch(envelope: Envelope, n: NormalizedRequest): SearchProjection | null {
  if (n.protocol !== 'openai_alpha_search') return null;
  const body = object(object(envelope.report.request).body);
  const response = object(object(envelope.report.response).body);
  const session = bounded(body.id, 256);
  const domain = isolationDomain(envelope, 'openai_responses');
  return {
    sessionKey: session && domain ? identityKey(domain, 'session', session) : null,
    outputHash:
      n.completeness === 'complete' && typeof response.output === 'string' && response.output.length
        ? hash(JSON.stringify(response.output))
        : null,
    operations: operations(body.commands),
    resultCount: Array.isArray(response.results) ? response.results.length : null,
  };
}

function originKind(item: Record<string, unknown>): SearchToolKind | 'other' {
  if (
    item.type === 'function_call' &&
    ((item.name === 'run' && item.namespace === 'web') ||
      (item.name === 'web.run' && item.namespace === undefined))
  )
    return 'web';
  if (
    item.type === 'custom_tool_call' &&
    item.name === 'exec' &&
    (item.namespace === undefined || item.namespace === 'default')
  )
    return 'exec';
  return 'other';
}

/** Candidates only: storage verifies the new-item boundary and unique thread-scoped origin. */
export function searchToolEvidence(envelope: Envelope, n: NormalizedRequest): SearchToolEvidence {
  const origins: SearchToolEvidence['origins'] = [];
  const parts: SearchToolEvidence['parts'] = [];
  if (n.protocol !== 'openai_responses') return { origins, parts };
  const body = object(object(envelope.report.request).body);
  const response = object(envelope.report.response);
  const input = array(body.input);
  const offset = n.input.length - input.length;
  const origin = (value: unknown) => {
    const item = object(value);
    const callId = bounded(item.call_id, 512);
    if (callId && typeof item.type === 'string' && item.type.endsWith('_call'))
      origins.push({ callId, kind: originKind(item) });
  };
  for (const [index, value] of input.entries()) {
    const item = object(value);
    origin(item);
    const callId = bounded(item.call_id, 512);
    if (!callId) continue;
    const add = (text: unknown, partIndex: number, kind: SearchToolKind) => {
      if (typeof text === 'string' && text.length > 0)
        parts.push({
          itemIndex: index + offset,
          partIndex,
          callId,
          kind,
          outputHash: hash(JSON.stringify(text)),
        });
    };
    if (item.type === 'function_call_output') {
      if (typeof item.output === 'string') add(item.output, 0, 'web');
      else if (Array.isArray(item.output) && item.output.length === 1) {
        const part = object(item.output[0]);
        if (part.type === 'input_text') add(part.text, 0, 'web');
      }
    } else if (item.type === 'custom_tool_call_output') {
      for (const [partIndex, value] of array(item.output).entries()) {
        const part = object(value);
        if (part.type === 'input_text') add(part.text, partIndex, 'exec');
      }
    }
  }
  // Read the source shells, never normalized display names/call IDs (which are shortened).
  const output = new Map(n.output.map((item) => [item.outputIndex ?? item.index, item]));
  const completedOrigin = (value: unknown, index: number, proven: boolean) => {
    const source = object(value);
    if (!proven || source.status === 'in_progress' || source.status === 'incomplete') return;
    const normalized = output.get(index);
    if (
      normalized?.completed &&
      normalized.prefixKnown !== false &&
      normalized.itemHash === responseItem(source).itemHash
    )
      origin(source);
  };
  const final = object(response.body);
  for (const [index, value] of array(final.output).entries())
    completedOrigin(
      value,
      index,
      final.status === 'completed' || object(value).status === 'completed',
    );
  for (const event of capturedEvents(response.events)) {
    if (event.type === 'response.output_item.done' && Number.isSafeInteger(event.data.output_index))
      completedOrigin(event.data.item, event.data.output_index as number, true);
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const snapshot = object(event.data.response);
      for (const [index, value] of array(snapshot.output).entries())
        completedOrigin(
          value,
          index,
          event.type === 'response.completed' || object(value).status === 'completed',
        );
    }
  }
  return { origins, parts };
}
