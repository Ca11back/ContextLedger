import { type Envelope, object } from '../../contracts';
import { identityId, isolationDomain, parseCodexIdentity } from '../identity';
import { chat } from './chat';
import { claude } from './claude';
import { type AdapterResult, capturedEvents, chainHashes, string } from './common';
import { gemini } from './gemini';
import { responses } from './responses';
import type { NormalizedMessage, NormalizedRequest } from './types';

export { canonicalJson, chainHashes } from './common';
export type {
  Completeness,
  MessageKind,
  NormalizedMessage,
  NormalizedPart,
  NormalizedRequest,
} from './types';

const chatProtocols = new Set(['openai', 'openai_responses', 'claude', 'gemini']);
function hasContent(messages: NormalizedMessage[]): boolean {
  return messages.some((m) => m.evidence && m.parts.some((p) => p.text.length > 0));
}
export function leadingHistoryCount(input: NormalizedMessage[]): number {
  // A trailing tool result follows the assistant tool call; keep all parallel results together.
  let i = input.length - 1;
  while (i >= 0 && input[i]!.kind === 'tool_result') i--;
  if (i < input.length - 1 && i >= 0 && input[i]!.kind === 'tool_call') return i + 1;
  for (i = input.length - 1; i >= 0; i--) if (input[i]!.kind === 'user') return i;
  return 0;
}
export function normalizeEnvelope(envelope: Envelope): NormalizedRequest {
  const protocol = string(envelope.context.format);
  const report = envelope.report;
  const body = object(object(report.request).body);
  const response = object(report.response);
  const final = object(response.body);
  const events = capturedEvents(response.events);
  let adapted: AdapterResult = { input: [], output: [], terminal: false };
  switch (protocol) {
    case 'openai':
      adapted = chat(body, final, events);
      break;
    case 'openai_responses':
      adapted = responses(body, final, events);
      break;
    case 'claude':
      adapted = claude(body, final, events);
      break;
    case 'gemini':
      adapted = gemini(body, final, events);
      break;
  }
  const failed =
    Number(response.status) >= 400 ||
    Boolean(report.error) ||
    Boolean(final.error) ||
    events.some(
      ({ type, data }) =>
        type === 'error' ||
        type === 'response.failed' ||
        type === 'response.error' ||
        Boolean(data.error),
    );
  const completeness = failed
    ? 'error'
    : response.truncated === true || !adapted.terminal || adapted.invalid
      ? 'partial'
      : 'complete';
  const input = adapted.input.map((m, index) => ({ ...m, side: 'input' as const, index }));
  const output = adapted.output.map((m, index) => ({ ...m, side: 'output' as const, index }));
  const evidence =
    completeness === 'error'
      ? []
      : completeness === 'complete'
        ? output
        : output.filter((m) => m.completed && m.evidence);
  const domain = isolationDomain(envelope, protocol);
  const previousResponseId =
    protocol === 'openai_responses' &&
    typeof body.previous_response_id === 'string' &&
    body.previous_response_id.trim()
      ? body.previous_response_id
      : null;
  const inputPrefixes = chainHashes(input);
  const inputEligible = input.some(
    (m) => !['system', 'context', 'reasoning', 'other'].includes(m.kind),
  );
  const inputChain = previousResponseId ? null : (inputPrefixes.at(-1) ?? null);
  const evidenceChain =
    !previousResponseId && completeness !== 'error' && inputEligible && hasContent(evidence)
      ? (chainHashes(evidence, inputPrefixes.at(-1) ?? 'cl-chain-v1').at(-1) ?? null)
      : null;
  const leading = leadingHistoryCount(input);
  const titleText =
    input
      .slice(leading)
      .find((m) => m.kind === 'user')
      ?.parts.find((p) => p.kind === 'text')?.text ?? '';
  return {
    protocol,
    chat: chatProtocols.has(protocol),
    domain,
    userId: identityId(object(report.user).id),
    tokenId: identityId(object(report.token).id),
    identity: chatProtocols.has(protocol) ? parseCodexIdentity(body, domain) : null,
    completeness,
    input,
    output,
    evidence,
    inputCount: input.length,
    evidenceCount: input.length + evidence.length,
    inputChain,
    evidenceChain,
    inputPrefixes,
    inputEligible,
    responseId: adapted.responseId || null,
    previousResponseId,
    title: titleText.slice(0, /[\uD800-\uDBFF]/.test(titleText[119] ?? '') ? 119 : 120),
    leadingHistoryCount: leading,
    media: [...input, ...output].some((m) => Boolean(m.media)),
    stopReason: adapted.stopReason || null,
  };
}
