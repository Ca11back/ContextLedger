import { object } from '../../contracts';
import {
  type AdapterResult,
  array,
  type CapturedEvent,
  contentMedia,
  contentProjection,
  contentValues,
  knownAssistantContent,
  message,
  roleKind,
  string,
} from './common';
import type { NormalizedMessage } from './types';

function chatMessage(value: unknown, completed = true): NormalizedMessage[] {
  const item = object(value);
  const role = string(item.role) || 'assistant';
  const calls = [...array(item.tool_calls)];
  const result: NormalizedMessage[] = [];
  if (
    (item.content !== null && item.content !== undefined) ||
    (calls.length === 0 && !item.function_call)
  ) {
    result.push(
      message(
        roleKind(role),
        {
          type: 'message',
          role,
          name: item.name,
          call_id: item.tool_call_id,
          content: contentProjection(item.content),
        },
        contentValues(item.content),
        { role, name: item.name, callId: item.tool_call_id, media: contentMedia(item.content) },
        completed,
      ),
    );
  }
  for (const normalized of result) normalized.evidence &&= knownAssistantContent(item.content);
  if (typeof item.refusal === 'string' && item.refusal.length)
    result.push(
      message(
        'refusal',
        { type: 'refusal', role, refusal: item.refusal },
        [item.refusal],
        { role },
        completed,
      ),
    );
  if (item.function_call) calls.push({ type: 'function', function: item.function_call });
  for (const value of calls) {
    const call = object(value);
    const fn = object(call.function);
    result.push(
      message(
        'tool_call',
        {
          type: call.type ?? 'function',
          role,
          call_id: call.id,
          name: fn.name,
          arguments: fn.arguments,
        },
        [fn.arguments ?? ''],
        { role, name: fn.name, callId: call.id },
        completed,
      ),
    );
  }
  return result;
}
interface Choice {
  role: string;
  content: string;
  refusal: string;
  finished: boolean;
  reason?: string;
  calls: Map<number, { id: string; type: string; function: { name: string; arguments: string } }>;
}
export function chat(
  body: Record<string, unknown>,
  final: Record<string, unknown>,
  events: CapturedEvent[],
): AdapterResult {
  const input = array(body.messages).flatMap((item) => chatMessage(item));
  if (Array.isArray(final.choices) && object(final.choices[0]).message) {
    const first = object(final.choices[0]);
    const output = chatMessage(first.message);
    if (output[0]) output[0].alternatives = Math.max(0, final.choices.length - 1);
    return {
      input,
      output,
      terminal: true,
      responseId: string(final.id),
      stopReason: string(first.finish_reason),
    };
  }
  const choices = new Map<number, Choice>();
  let responseId = '';
  for (const { data } of events) {
    responseId ||= string(data.id);
    for (const value of array(data.choices)) {
      const item = object(value);
      const index = typeof item.index === 'number' ? item.index : 0;
      let state = choices.get(index);
      if (!state) {
        state = { role: 'assistant', content: '', refusal: '', finished: false, calls: new Map() };
        choices.set(index, state);
      }
      const delta = object(item.delta);
      state.role = string(delta.role) || state.role;
      state.content += string(delta.content);
      state.refusal += string(delta.refusal);
      const calls = [...array(delta.tool_calls)];
      if (delta.function_call) calls.push({ index: 0, function: delta.function_call });
      for (const value of calls) {
        const call = object(value);
        const fn = object(call.function);
        const callIndex = typeof call.index === 'number' ? call.index : 0;
        let tool = state.calls.get(callIndex);
        if (!tool) {
          tool = { id: '', type: 'function', function: { name: '', arguments: '' } };
          state.calls.set(callIndex, tool);
        }
        tool.id ||= string(call.id);
        tool.type = string(call.type) || tool.type;
        tool.function.name += string(fn.name);
        tool.function.arguments += string(fn.arguments);
      }
      if (item.finish_reason !== null && item.finish_reason !== undefined) {
        state.finished = true;
        state.reason = string(item.finish_reason);
      }
    }
  }
  const primary = choices.get(0);
  const output = primary
    ? chatMessage(
        {
          role: primary.role,
          content: primary.content || (primary.calls.size ? null : ''),
          refusal: primary.refusal,
          tool_calls: [...primary.calls].sort(([a], [b]) => a - b).map(([, call]) => call),
        },
        primary.finished,
      )
    : [];
  if (output[0]) output[0].alternatives = Math.max(0, choices.size - 1);
  return {
    input,
    output,
    terminal: primary?.finished === true,
    responseId,
    stopReason: primary?.reason,
  };
}
