import { object } from '../../contracts';
import {
  type AdapterResult,
  array,
  type CapturedEvent,
  contentMedia,
  contentProjection,
  contentValues,
  knownAssistantContent,
  mediaDisplay,
  message,
  roleKind,
  string,
} from './common';
import type { NormalizedMessage } from './types';

const controls = new Set(['compaction', 'context', 'additional_tools', 'configuration_update']);
export function responseItem(value: unknown, completed = true): NormalizedMessage {
  const item = object(value);
  const type = string(item.type) || (item.role ? 'message' : 'unknown');
  const role = string(item.role) || (type === 'message' ? 'user' : '');
  const fields = { role, name: item.name, callId: item.call_id };
  if (type === 'message') {
    const normalized = message(
      roleKind(role),
      {
        type,
        role,
        name: item.name,
        call_id: item.call_id,
        content: contentProjection(item.content),
      },
      contentValues(item.content),
      { ...fields, media: contentMedia(item.content) },
      completed,
    );
    normalized.evidence &&= knownAssistantContent(item.content);
    return normalized;
  }
  if (type === 'function_call' || type === 'custom_tool_call') {
    const key = type === 'function_call' ? 'arguments' : 'input';
    return message(
      'tool_call',
      { type, name: item.name, call_id: item.call_id, [key]: item[key] },
      [item[key] ?? ''],
      fields,
      completed,
    );
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output')
    return message(
      'tool_result',
      { type, call_id: item.call_id, output: item.output },
      [item.output ?? ''],
      fields,
      completed,
    );
  if (type === 'reasoning')
    return message(
      'reasoning',
      { type, summary: contentProjection(item.summary) },
      contentValues(item.summary),
      fields,
      completed,
    );
  if (controls.has(type)) return message('context', item, [], fields, completed);
  if (type === 'input_image' || type === 'input_audio' || type === 'input_file')
    return message(
      'media',
      item,
      mediaDisplay(item)!.values,
      { ...fields, media: mediaDisplay(item)!.label },
      completed,
    );
  return message('other', value, [value], fields, completed);
}
function inputItems(body: Record<string, unknown>): NormalizedMessage[] {
  const result: NormalizedMessage[] = [];
  if (body.instructions !== undefined && body.instructions !== null && body.instructions !== '') {
    result.push(
      message('system', { type: 'instructions', content: body.instructions }, [body.instructions], {
        role: 'system',
      }),
    );
  }
  const items =
    typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : array(body.input);
  result.push(...items.map((item) => responseItem(item)));
  return result;
}
export function responses(
  body: Record<string, unknown>,
  final: Record<string, unknown>,
  events: CapturedEvent[],
): AdapterResult {
  let selected = final;
  let terminal = Array.isArray(final.output) && final.status === 'completed';
  const recovered = new Map<number, NormalizedMessage>();
  let nextIndex = 0;
  for (const event of events) {
    if (event.type === 'response.completed' && Array.isArray(object(event.data.response).output)) {
      selected = object(event.data.response);
      terminal = selected.status === undefined || selected.status === 'completed';
    }
    if (event.type === 'response.output_item.done' && event.data.item !== undefined) {
      const index =
        typeof event.data.output_index === 'number' ? event.data.output_index : nextIndex++;
      const item = object(event.data.item);
      recovered.set(
        index,
        responseItem(item, item.status !== 'in_progress' && item.status !== 'incomplete'),
      );
    }
  }
  const output =
    Array.isArray(selected.output) && (terminal || recovered.size === 0)
      ? selected.output.map((item) =>
          responseItem(
            item,
            object(item).status !== 'in_progress' && object(item).status !== 'incomplete',
          ),
        )
      : [...recovered].sort(([a], [b]) => a - b).map(([, item]) => item);
  return {
    input: inputItems(body),
    output,
    terminal,
    responseId:
      string(selected.id) || events.map((e) => string(object(e.data.response).id)).find(Boolean),
    stopReason: string(object(selected.incomplete_details).reason) || undefined,
  };
}
