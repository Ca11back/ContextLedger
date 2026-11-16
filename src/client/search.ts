export const textFilters = ['request', 'model', 'channel', 'user', 'token'] as const;
export const filterKeys = [...textFilters, 'outcome', 'truncated', 'media', 'from', 'to'] as const;
export type FilterKey = (typeof filterKeys)[number];
export type DashboardSearch = Partial<Record<FilterKey, string>> & {
  view?: 'uploads';
  selected?: number;
};

function integer(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  if (!/^\d+$/.test(String(value))) return;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export function validateDashboardSearch(input: Record<string, unknown>): DashboardSearch {
  const result: DashboardSearch = {};
  for (const key of textFilters) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) result[key] = value;
  }
  if (input.outcome === 'reported' || input.outcome === 'error') result.outcome = input.outcome;
  for (const key of ['truncated', 'media'] as const)
    if (input[key] === '0' || input[key] === '1') result[key] = input[key];
  for (const key of ['from', 'to'] as const) {
    const value = integer(input[key]);
    if (value !== undefined) result[key] = String(value);
  }
  if (result.from && result.to && Number(result.from) > Number(result.to)) {
    delete result.from;
    delete result.to;
  }
  if (input.view === 'uploads') result.view = 'uploads';
  const selected = integer(input.selected);
  if (selected && selected > 0) result.selected = selected;
  return result;
}

export function recordParams(search: DashboardSearch, cursor?: number): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of filterKeys) if (search[key] !== undefined) params.set(key, search[key]);
  params.set('limit', '25');
  if (cursor !== undefined) params.set('cursor', String(cursor));
  return params;
}
