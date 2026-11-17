import { object } from '../../contracts';
import {
  type AdapterResult,
  array,
  boundedUserText,
  type CapturedEvent,
  mediaDisplay,
  message,
  roleKind,
  string,
} from './common';
import type { NormalizedMessage } from './types';

function block(value: unknown, role: string, completed = true): NormalizedMessage {
  const b = object(value);
  const type = string(b.type);
  if (type === 'text')
    return message(
      roleKind(role),
      { type, role, text: b.text },
      [b.text ?? ''],
      { role },
      completed,
    );
  if (type === 'thinking')
    return message(
      'reasoning',
      { type, role, thinking: b.thinking, signature: b.signature },
      [b.thinking ?? ''],
      { role },
      completed,
    );
  if (type === 'redacted_thinking')
    return message('reasoning', { type, role }, [], { role }, completed);
  if (type === 'tool_use' || type === 'server_tool_use')
    return message(
      'tool_call',
      { type, role, name: b.name, call_id: b.id, input: b.input },
      [b.input ?? ''],
      { role, name: b.name, callId: b.id },
      completed,
    );
  if (type === 'tool_result' || type.endsWith('_tool_result'))
    return message(
      'tool_result',
      { type, call_id: b.tool_use_id, content: b.content, is_error: b.is_error },
      [b.content ?? ''],
      { role, callId: b.tool_use_id },
      completed,
    );
  if (type === 'image' || type === 'document')
    return message(
      'media',
      { ...b, role },
      mediaDisplay(b)!.values,
      { role, media: mediaDisplay(b)!.label },
      completed,
    );
  return message('other', { ...b, role }, [value], { role }, completed);
}
function blocks(content: unknown, role: string, completed = true): NormalizedMessage[] {
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : array(content);
  const userText =
    role === 'user'
      ? boundedUserText(
          items.flatMap((item) => (object(item).type === 'text' ? [object(item).text] : [])),
        )
      : '';
  return items.map((item) => {
    const result = block(item, role, completed);
    if (result.kind === 'user') result.userText = userText;
    return result;
  });
}
interface BlockState {
  value: Record<string, unknown>;
  stopped: boolean;
  json: string;
  hasJson: boolean;
  invalid: boolean;
}
export function claude(
  body: Record<string, unknown>,
  final: Record<string, unknown>,
  events: CapturedEvent[],
): AdapterResult {
  const input = blocks(body.system, 'system');
  for (const value of array(body.messages)) {
    const item = object(value);
    input.push(...blocks(item.content, string(item.role) || 'user'));
  }
  if (Array.isArray(final.content))
    return {
      input,
      output: blocks(final.content, 'assistant'),
      terminal: typeof final.stop_reason === 'string' && final.stop_reason.length > 0,
      responseId: string(final.id),
      stopReason: string(final.stop_reason),
    };
  const states = new Map<number, BlockState>();
  let stopped = false;
  let reason = '';
  let invalid = false;
  let responseId = '';
  for (const { type, data } of events) {
    const index = typeof data.index === 'number' ? data.index : -1;
    switch (type) {
      case 'message_start': {
        const initial = object(data.message);
        responseId = string(initial.id);
        for (const [i, value] of array(initial.content).entries())
          states.set(i, {
            value: { ...object(value) },
            stopped: false,
            json: '',
            hasJson: false,
            invalid: false,
          });
        break;
      }
      case 'content_block_start':
        if (index < 0 || states.has(index)) {
          invalid = true;
          break;
        }
        states.set(index, {
          value: { ...object(data.content_block) },
          stopped: false,
          json: '',
          hasJson: false,
          invalid: false,
        });
        break;
      case 'content_block_delta': {
        const state = states.get(index);
        if (!state || state.stopped) {
          invalid = true;
          break;
        }
        const delta = object(data.delta);
        switch (delta.type) {
          case 'text_delta':
            state.value.text = string(state.value.text) + string(delta.text);
            break;
          case 'thinking_delta':
            state.value.thinking = string(state.value.thinking) + string(delta.thinking);
            break;
          case 'signature_delta':
            state.value.signature = string(state.value.signature) + string(delta.signature);
            break;
          case 'input_json_delta':
            state.hasJson = true;
            state.json += string(delta.partial_json);
            break;
          default:
            state.invalid = true;
            state.value = { ...state.value, unknown_delta: delta };
            break;
        }
        break;
      }
      case 'content_block_stop': {
        const state = states.get(index);
        if (!state || state.stopped) {
          invalid = true;
          break;
        }
        state.stopped = true;
        if (state.hasJson) {
          try {
            state.value.input = JSON.parse(state.json);
          } catch {
            state.value.input = state.json;
            state.invalid = true;
          }
        }
        break;
      }
      case 'message_delta':
        reason = string(object(data.delta).stop_reason) || reason;
        break;
      case 'message_stop':
        stopped = true;
        break;
    }
  }
  const ordered = [...states].sort(([a], [b]) => a - b);
  invalid ||= ordered.some(([index, state], i) => index !== i || !state.stopped || state.invalid);
  const output = ordered.map(([index, state]) => {
    if (state.hasJson && !state.stopped)
      return {
        ...block({ ...state.value, input: state.json }, 'assistant', false),
        outputIndex: index,
      };
    const result = block(state.value, 'assistant', state.stopped && !state.invalid);
    result.outputIndex = index;
    if (state.invalid) {
      result.evidence = false;
      result.prefixKnown = false;
    }
    return result;
  });
  return {
    input,
    output,
    terminal: stopped && Boolean(reason) && !invalid,
    invalid,
    responseId,
    stopReason: reason,
  };
}
