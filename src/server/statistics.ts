import { object } from '../contracts';

export const statisticColumns = [
  'cache_read_tokens',
  'cache_write_tokens',
  'input_total_tokens',
  'charge_usd',
] as const;
export type Statistics = Record<(typeof statisticColumns)[number], number | null>;
const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const tokens = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const writeEvidenceKeys = [
  'cacheWriteTokens',
  'cacheCreationTokens',
  'cacheCreationTokens5m',
  'cacheCreationTokens1h',
  'cacheCreationTokens12h',
] as const;

/** Gateway billing projections; use raw usage so malformed fields remain present evidence. */
export function statistics(protocol: string, usageValue: unknown, costValue: unknown): Statistics {
  const usage = object(usageValue);
  const cost = object(costValue);
  const read = tokens(usage.cacheTokens);
  const creation = tokens(usage.cacheCreationTokens);
  const short = tokens(usage.cacheCreationTokens5m);
  const long = tokens(usage.cacheCreationTokens1h);
  // The duration aliases partition Claude writes. The 12h field is only a subset
  // of OpenAI writes, so it cannot establish a total on its own.
  const durations = short === null && long === null ? null : (short ?? 0) + (long ?? 0);
  let write =
    tokens(usage.cacheWriteTokens) ??
    tokens(creation === null ? durations : Math.max(creation, durations ?? 0));
  const includesCachedInput =
    protocol === 'openai' || protocol === 'openai_responses' || protocol === 'gemini';
  // These formats omit zero writes. Valid read evidence distinguishes a usage
  // report from missing usage; any write field, including malformed/12h-only,
  // prevents interpreting that omission as a known zero.
  if (
    write === null &&
    includesCachedInput &&
    read !== null &&
    writeEvidenceKeys.every((key) => !Object.hasOwn(usage, key))
  )
    write = 0;
  const prompt = tokens(usage.promptTokens);
  let total = tokens(usage.inputTokensTotal);
  if (total === null) {
    if (includesCachedInput) total = prompt;
    else if (protocol === 'claude' && prompt !== null && read !== null && write !== null)
      total = prompt + read + write;
  }
  return {
    cache_read_tokens: read,
    cache_write_tokens: write,
    input_total_tokens: tokens(total),
    charge_usd: numeric(cost.usd),
  };
}
