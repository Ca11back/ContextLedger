import { infiniteQueryOptions, QueryClient, queryOptions } from '@tanstack/react-query';
import type { Metrics, RecordList, UploadList } from '../client-contracts';
import type { RecordView } from '../view-contracts';
import { type DashboardSearch, recordParams } from './search';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? '管理员身份验证已失效，请重新登录。'
        : status === 404
          ? '记录或路径不存在，记录可能已被保留策略清理。'
          : status === 400
            ? '筛选或路径参数无效，请返回上一层重试。'
            : `读取失败（HTTP ${status}），请稍后重试。`,
    );
  }
}
export async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new ApiError(response.status);
  return response.json() as Promise<T>;
}
export function createDashboardQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}
export function recordsQuery(search: DashboardSearch) {
  const filters = recordParams(search).toString();
  return infiniteQueryOptions({
    queryKey: ['records', filters],
    initialPageParam: undefined as number | undefined,
    maxPages: 4,
    queryFn: ({ signal, pageParam }) =>
      readJson<RecordList>(`/api/records?${recordParams(search, pageParam)}`, signal),
    getNextPageParam: (page) => page.cursor ?? undefined,
  });
}
export const metricsQuery = queryOptions({
  queryKey: ['metrics'],
  queryFn: ({ signal }) => readJson<Metrics>('/api/metrics', signal),
});
export const uploadsQuery = queryOptions({
  queryKey: ['uploads'],
  queryFn: ({ signal }) => readJson<UploadList>('/api/uploads', signal),
});
export function recordViewQuery(id: number, path: string[], offset: number) {
  const params = new URLSearchParams({
    path: JSON.stringify(path),
    offset: String(offset),
    limit: '20',
  });
  return queryOptions({
    queryKey: ['record-view', id, path, offset],
    gcTime: 0,
    queryFn: ({ signal }) => readJson<RecordView>(`/api/records/${id}/view?${params}`, signal),
  });
}
