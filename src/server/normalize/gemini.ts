import { object } from '../../contracts';
import {
  type AdapterResult,
  array,
  type CapturedEvent,
  mediaDisplay,
  message,
  roleKind,
  string,
} from './common';
import type { NormalizedMessage } from './types';

/** Join adjacent textual deltas only; a thought/answer/call boundary is semantic. */
function appendPart(parts: Record<string, unknown>[], value: unknown): void {
  const part = object(value);
  const last = parts.at(-1);
  if (
    typeof part.text === 'string' &&
    last &&
    typeof last.text === 'string' &&
    Boolean(last.thought) === Boolean(part.thought) &&
    (last.thoughtSignature === undefined ||
      part.thoughtSignature === undefined ||
      last.thoughtSignature === part.thoughtSignature) &&
    Object.keys(part).every((key) => ['text', 'thought', 'thoughtSignature'].includes(key)) &&
    Object.keys(last).every((key) => ['text', 'thought', 'thoughtSignature'].includes(key))
  ) {
    last.text += part.text;
    if (part.thoughtSignature !== undefined) last.thoughtSignature = part.thoughtSignature;
  } else parts.push({ ...part });
}
function normalizeParts(values: unknown, role: string, completed = true): NormalizedMessage[] {
  const parts: Record<string, unknown>[] = [];
  for (const value of array(values)) appendPart(parts, value);
  return parts.map((p) => {
    const fields = { role };
    if (typeof p.text === 'string') {
      const known = Object.keys(p).every((key) =>
        ['text', 'thought', 'thoughtSignature'].includes(key),
      );
      return message(
        known ? (p.thought === true ? 'reasoning' : roleKind(role)) : 'other',
        { role, part: p },
        known ? [p.text] : [p],
        fields,
        completed,
      );
    }
    if (p.functionCall) {
      const call = object(p.functionCall);
      return message(
        'tool_call',
        { role, part: p },
        [call.args ?? ''],
        { role, name: call.name, callId: call.id },
        completed,
      );
    }
    if (p.functionResponse) {
      const call = object(p.functionResponse);
      return message(
        'tool_result',
        { role, part: p },
        [call.response ?? ''],
        { role, name: call.name, callId: call.id },
        completed,
      );
    }
    if (p.inlineData || p.fileData)
      return message(
        'media',
        { role, part: p },
        mediaDisplay(p, 'gemini')!.values,
        { role, media: mediaDisplay(p, 'gemini')!.label },
        completed,
      );
    return message('other', { role, part: p }, [p], fields, completed);
  });
}
export function gemini(
  body: Record<string, unknown>,
  final: Record<string, unknown>,
  events: CapturedEvent[],
): AdapterResult {
  const input = normalizeParts(
    object(body.systemInstruction ?? body.system_instruction).parts,
    'system',
  );
  for (const value of array(body.contents)) {
    const content = object(value);
    input.push(
      ...normalizeParts(
        content.parts,
        content.role === 'model' ? 'assistant' : string(content.role) || 'user',
      ),
    );
  }
  if (Array.isArray(final.candidates)) {
    const candidate = object(final.candidates[0]);
    const output = normalizeParts(object(candidate.content).parts, 'assistant');
    if (output[0]) output[0].alternatives = Math.max(0, final.candidates.length - 1);
    return {
      input,
      output,
      terminal: Boolean(candidate.finishReason),
      responseId: string(final.responseId),
      stopReason: string(candidate.finishReason),
    };
  }
  const candidates = new Map<number, { parts: Record<string, unknown>[]; reason: string }>();
  let responseId = '';
  for (const { data } of events) {
    responseId ||= string(data.responseId);
    for (const value of array(data.candidates)) {
      const candidate = object(value);
      const index = typeof candidate.index === 'number' ? candidate.index : 0;
      let state = candidates.get(index);
      if (!state) {
        state = { parts: [], reason: '' };
        candidates.set(index, state);
      }
      for (const part of array(object(candidate.content).parts)) appendPart(state.parts, part);
      state.reason = string(candidate.finishReason) || state.reason;
    }
  }
  const primary = candidates.get(0);
  const output = primary ? normalizeParts(primary.parts, 'assistant', Boolean(primary.reason)) : [];
  if (output[0]) output[0].alternatives = Math.max(0, candidates.size - 1);
  return {
    input,
    output,
    terminal: Boolean(primary?.reason),
    responseId,
    stopReason: primary?.reason,
  };
}
