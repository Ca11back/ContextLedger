import { infiniteQueryOptions, QueryClient, queryOptions } from '@tanstack/react-query';
import type { Metrics, UploadList } from '../client-contracts';
import type {
  ConversationDetail,
  ConversationList,
  FragmentPage,
  LookupResult,
  RequestList,
  RequestRow,
  TextChunk,
} from '../conversation-contracts';
import type { RecordView } from '../view-contracts';
import { type AppSearch, conversationFilterKeys, listParams, requestFilterKeys } from './search';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? '登录已失效，请刷新页面重新登录。'
        : status === 404
          ? '没有找到这条内容，它可能已被容量清理删除。'
          : status === 400
            ? '筛选条件或链接参数无效，请重置筛选后再试。'
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

export function conversationsQuery(search: AppSearch) {
  const key = listParams(search, null, conversationFilterKeys).toString();
  return infiniteQueryOptions({
    queryKey: ['conversations', key],
    initialPageParam: null as string | null,
    maxPages: 6,
    queryFn: ({ signal, pageParam }) =>
      readJson<ConversationList>(
        `/api/conversations?${listParams(search, pageParam, conversationFilterKeys)}`,
        signal,
      ),
    getNextPageParam: (page) => page.cursor,
  });
}

export function requestsQuery(search: AppSearch) {
  const key = listParams(search, null, requestFilterKeys).toString();
  return infiniteQueryOptions({
    queryKey: ['requests', key],
    initialPageParam: null as string | null,
    maxPages: 6,
    queryFn: ({ signal, pageParam }) =>
      readJson<RequestList>(
        `/api/requests?${listParams(search, pageParam, requestFilterKeys)}`,
        signal,
      ),
    getNextPageParam: (page) => page.cursor,
  });
}

/** One request row, including its search projection and incomplete reason. */
export function requestQuery(id: number) {
  return queryOptions({
    queryKey: ['request', id],
    queryFn: ({ signal }) => readJson<RequestRow>(`/api/requests/${id}`, signal),
  });
}

export function conversationQuery(id: number) {
  return queryOptions({
    queryKey: ['conversation', id],
    queryFn: ({ signal }) => readJson<ConversationDetail>(`/api/conversations/${id}`, signal),
  });
}

/**
 * Fragment stream of a conversation. `at` starts exactly at `startTurn` (404 when that turn is
 * gone, for deep links); `from` starts at the first existing turn at or after it.
 */
export function fragmentsQuery(
  id: number,
  startTurn: number | undefined,
  mode: 'at' | 'from' = 'at',
) {
  // From turn 1 is the whole conversation; share its cache entry with the unanchored stream.
  const turn = mode === 'from' && startTurn !== undefined && startTurn <= 1 ? undefined : startTurn;
  return infiniteQueryOptions({
    queryKey: ['fragments', id, turn ?? 0, turn === undefined ? 'at' : mode],
    initialPageParam: null as string | null,
    gcTime: 30_000,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', pageParam);
      else if (turn) params.set(mode === 'at' ? 'startTurn' : 'fromTurn', String(turn));
      return readJson<FragmentPage>(`/api/conversations/${id}/fragments?${params}`, signal);
    },
    getNextPageParam: (page) => page.cursor,
  });
}

export function textQuery(continuation: string) {
  return queryOptions({
    queryKey: ['text', continuation],
    gcTime: 30_000,
    queryFn: ({ signal }) =>
      readJson<TextChunk>(`/api/text/${encodeURIComponent(continuation)}`, signal),
  });
}

export function lookupQuery(q: string) {
  return queryOptions({
    queryKey: ['lookup', q],
    queryFn: ({ signal }) =>
      readJson<LookupResult>(`/api/lookup?${new URLSearchParams({ q })}`, signal),
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
