// URL state for the single-screen UI. Everything the user can share or refresh lives here.

export const filterKeys = ['user', 'token', 'model', 'status', 'kind', 'from', 'to'] as const;
export type FilterKey = (typeof filterKeys)[number];
export const statusValues = ['error', 'partial', 'media'] as const;
export const kindValues = ['main', 'subagent'] as const;

export interface AppSearch {
  tab?: 'requests';
  /** Open conversation. */
  c?: number;
  /** Anchored turn inside the open conversation. */
  t?: number;
  /** Open single request (requests without a conversation). */
  r?: number;
  user?: string;
  token?: string;
  model?: string;
  status?: (typeof statusValues)[number];
  kind?: (typeof kindValues)[number];
  from?: number;
  to?: number;
}

function positive(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  if (!/^\d{1,15}$/.test(String(value))) return;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

export function validateAppSearch(input: Record<string, unknown>): AppSearch {
  const result: AppSearch = {};
  if (input.tab === 'requests') result.tab = 'requests';
  for (const key of ['c', 't', 'r', 'from', 'to'] as const) {
    const value = positive(input[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ['user', 'token', 'model'] as const) {
    const value = text(input[key]);
    if (value !== undefined) result[key] = value;
  }
  if (statusValues.includes(input.status as never))
    result.status = input.status as AppSearch['status'];
  if (kindValues.includes(input.kind as never)) result.kind = input.kind as AppSearch['kind'];
  if (result.from && result.to && result.from > result.to) {
    delete result.from;
    delete result.to;
  }
  if (!result.c) delete result.t;
  return result;
}

export function hasFilters(search: AppSearch): boolean {
  return filterKeys.some((key) => search[key] !== undefined);
}

export function listParams(
  search: AppSearch,
  cursor: string | null | undefined,
  keys: readonly FilterKey[],
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = search[key];
    if (value !== undefined) params.set(key, String(value));
  }
  if (cursor) params.set('cursor', cursor);
  return params;
}

export const conversationFilterKeys = filterKeys;
export const requestFilterKeys = ['user', 'token', 'model', 'status', 'from', 'to'] as const;
