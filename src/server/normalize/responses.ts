import { object } from '../../contracts';
import { hash } from '../codec';
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
  sourceUserText,
  string,
} from './common';
import type { AnnouncedOutputItem, NormalizedMessage } from './types';

const controls = new Set(['compaction', 'context', 'additional_tools', 'configuration_update']);
const knownTypes = new Set([
  'message',
  'function_call',
  'custom_tool_call',
  'function_call_output',
  'custom_tool_call_output',
  'reasoning',
]);
function shellId(item: Record<string, unknown>): string | undefined {
  return typeof item.id === 'string' && item.id.trim().length > 0 && item.id.length <= 512
    ? hash(item.id)
    : undefined;
}
export function responseItem(value: unknown, completed = true): NormalizedMessage {
  const item = object(value);
  const normalized = normalizeResponseItem(value, completed);
  const type = string(item.type) || (item.role ? 'message' : 'unknown');
  if (knownTypes.has(type)) {
    normalized.wireItemType = type;
    normalized.itemIdHash = shellId(item);
  }
  return normalized;
}
function normalizeResponseItem(value: unknown, completed = true): NormalizedMessage {
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
      {
        ...fields,
        media: contentMedia(item.content),
        userText: role === 'user' ? sourceUserText(item.content) : '',
      },
      completed,
    );
    normalized.evidence &&= knownAssistantContent(item.content);
    normalized.prefixKnown =
      typeof item.content === 'string' ||
      (Array.isArray(item.content) &&
        item.content.every((value) => {
          const type = string(object(value).type);
          return [
            'input_text',
            'output_text',
            'text',
            'refusal',
            'input_image',
            'image_url',
            'input_audio',
            'input_file',
          ].includes(type);
        }));
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
  if (type === 'reasoning') {
    const normalized = message(
      'reasoning',
      { type, summary: contentProjection(item.summary) },
      contentValues(item.summary),
      fields,
      completed,
    );
    normalized.prefixKnown =
      item.summary === undefined ||
      (Array.isArray(item.summary) &&
        item.summary.every((value) =>
          ['summary_text', 'text'].includes(string(object(value).type)),
        ));
    return normalized;
  }
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
  let completed = Array.isArray(final.output) && final.status === 'completed';
  let terminal =
    final.status === 'completed' || final.status === 'incomplete' || final.status === 'failed';
  let incomplete = final.status === 'incomplete';
  const recovered = new Map<number, NormalizedMessage>();
  let nextIndex = 0;
  const announced: AnnouncedOutputItem[] = [];
  const announcedIds = new Set<string>();
  const completedIndexes = new Set<number>();
  let announcementsValid = true;
  let sawAnnouncement = false;
  let recoveryValid = true;
  for (const event of events) {
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
      terminal = true;
      const snapshot = object(event.data.response);
      if (event.type === 'response.incomplete') incomplete = true;
      if (Object.keys(snapshot).length) selected = snapshot;
      if (event.type === 'response.completed')
        completed =
          Array.isArray(snapshot.output) &&
          (snapshot.status === undefined || snapshot.status === 'completed');
    }
    if (event.type === 'response.output_item.added') {
      sawAnnouncement = true;
      const item = object(event.data.item);
      const type = string(item.type);
      const idHash = shellId(item);
      const index = event.data.output_index;
      if (
        !Number.isSafeInteger(index) ||
        index !== announced.length ||
        !idHash ||
        !knownTypes.has(type) ||
        announcedIds.has(idHash) ||
        announced.length >= 256
      ) {
        announcementsValid = false;
      } else if (announcementsValid) {
        announced.push({ index: index as number, type, idHash });
        announcedIds.add(idHash);
      }
    }
    if (event.type === 'response.output_item.done' && event.data.item === undefined) {
      recoveryValid = false;
      announcementsValid = false;
    }
    if (event.type === 'response.output_item.done' && event.data.item !== undefined) {
      const sourceIndex = event.data.output_index;
      const validIndex =
        typeof sourceIndex === 'number' && Number.isSafeInteger(sourceIndex) && sourceIndex >= 0;
      const index = validIndex ? sourceIndex : nextIndex++;
      const item = object(event.data.item);
      const normalized = responseItem(
        item,
        item.status !== 'in_progress' && item.status !== 'incomplete',
      );
      normalized.outputIndex = index;
      if (!validIndex || completedIndexes.has(index)) {
        recoveryValid = false;
        announcementsValid = false;
      }
      completedIndexes.add(index);
      recovered.set(index, normalized);
      const announcedItem = announced[index];
      if (
        !validIndex ||
        !announcedItem ||
        announcedItem.idHash !== shellId(item) ||
        announcedItem.type !== item.type
      )
        announcementsValid = false;
      else if (
        normalized.completed &&
        normalized.kind !== 'other' &&
        normalized.prefixKnown !== false
      )
        announcedItem.completedHash = normalized.itemHash;
      else announcementsValid = false;
    }
  }

  const output =
    Array.isArray(selected.output) && (completed || recovered.size === 0)
      ? selected.output.map((item) =>
          responseItem(
            item,
            object(item).status !== 'in_progress' && object(item).status !== 'incomplete',
          ),
        )
      : [...recovered].sort(([a], [b]) => a - b).map(([, item]) => item);
  // A partial body can retain completed items even when no done event was captured.
  // Bind those known results as well; their announcement must not degrade to id-only proof.
  if (announcementsValid && sawAnnouncement)
    for (const [index, value] of array(selected.output).entries()) {
      const item = responseItem(
        value,
        object(value).status !== 'in_progress' && object(value).status !== 'incomplete',
      );
      const announcement = announced[index];
      if (
        !announcement ||
        item.itemIdHash !== announcement.idHash ||
        item.wireItemType !== announcement.type
      ) {
        announcementsValid = false;
        break;
      } else if (item.completed) {
        if (
          item.kind === 'other' ||
          item.prefixKnown === false ||
          (announcement.completedHash !== undefined && announcement.completedHash !== item.itemHash)
        ) {
          announcementsValid = false;
          break;
        } else announcement.completedHash = item.itemHash;
      }
    }
  if (!recoveryValid && !completed && output[0]) output[0].prefixKnown = false;
  const validAnnouncements =
    announcementsValid &&
    sawAnnouncement &&
    announced.length > 0 &&
    Buffer.byteLength(JSON.stringify(announced)) <= 65_536;
  return {
    input: inputItems(body),
    output,
    terminal,
    incomplete,
    // Invalid recovery positions remain readable but cannot establish a prefix.
    ...(!completed && (!recoveryValid || (terminal && !incomplete)) ? { invalid: true } : {}),
    announcedOutput: validAnnouncements ? announced : [],
    announcementsValid: validAnnouncements,
    responseId:
      string(selected.id) || events.map((e) => string(object(e.data.response).id)).find(Boolean),
    stopReason: string(object(selected.incomplete_details).reason) || undefined,
  };
}
