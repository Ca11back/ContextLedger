import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { count, shortId, when } from '../client/format';
import { conversationsQuery, requestsQuery } from '../client/queries';
import { type AppSearch, hasFilters, validateAppSearch } from '../client/search';
import { useSentinel } from '../client/sentinel';
import { modalOpen } from '../client/shortcuts';
import { EmptyState, ErrorState, Loading } from './Feedback';

type Navigate = (next: AppSearch) => void;

const statusLabels = { error: '有报错', partial: '回复不完整', media: '含图片' } as const;
const kindLabels = { main: '主对话', subagent: '子代理' } as const;

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function FilterBar({
  search,
  go,
  conversations,
}: {
  search: AppSearch;
  go: Navigate;
  conversations: boolean;
}) {
  const today = startOfToday();
  const isToday = search.from === today && search.to === undefined;
  return (
    <fieldset className="filters">
      <legend className="sr-only">筛选</legend>
      <Chip
        on={isToday}
        label="今天"
        onClick={() => go({ ...search, from: isToday ? undefined : today, to: undefined })}
      />
      {conversations &&
        (['main', 'subagent'] as const).map((kind) => (
          <Chip
            key={kind}
            on={search.kind === kind}
            label={kindLabels[kind]}
            onClick={() => go({ ...search, kind: search.kind === kind ? undefined : kind })}
          />
        ))}
      {(['error', 'partial', 'media'] as const).map((status) => (
        <Chip
          key={status}
          on={search.status === status}
          label={statusLabels[status]}
          onClick={() => go({ ...search, status: search.status === status ? undefined : status })}
        />
      ))}
      {(['user', 'token', 'model'] as const).map((key) =>
        search[key] ? (
          <Chip
            key={key}
            on
            label={`${{ user: '用户', token: '令牌', model: '模型' }[key]}：${search[key]} ×`}
            onClick={() => go({ ...search, [key]: undefined })}
          />
        ) : null,
      )}
      {hasFilters(search) && (
        <button
          type="button"
          className="link small"
          onClick={() => go({ tab: search.tab, c: search.c, t: search.t, r: search.r })}
        >
          清除筛选
        </button>
      )}
    </fieldset>
  );
}

/** Loads the next page when the callback-ref sentinel is on screen (see useSentinel). */
function useAutoLoad(query: {
  hasNextPage: boolean;
  isFetching: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const { fetchNextPage } = query;
  const load = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  const sentinel = useSentinel({
    hasNextPage: query.hasNextPage,
    isFetching: query.isFetching,
    failed: query.isFetchNextPageError,
    load,
  });
  return { ...sentinel, load };
}

function ManualLoad({ sentinel }: { sentinel: ReturnType<typeof useAutoLoad> }) {
  if (!sentinel.showManual) return null;
  return (
    <button type="button" className="link small load-more" onClick={sentinel.load}>
      继续载入
    </button>
  );
}

/** j / k move through rows outside text inputs. */
function useRowKeys(ids: number[], current: number | undefined, open: (id: number) => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return;
      if (event.key !== 'j' && event.key !== 'k') return;
      if (modalOpen()) return;
      const index = current === undefined ? -1 : ids.indexOf(current);
      const next = ids[event.key === 'j' ? index + 1 : Math.max(0, index - 1)];
      if (next !== undefined) {
        event.preventDefault();
        open(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, current, open]);
}

export function ConversationList({ search, go }: { search: AppSearch; go: Navigate }) {
  const query = useInfiniteQuery(conversationsQuery(search));
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const target = (id: number) =>
    validateAppSearch({ ...search, c: id, t: undefined, r: undefined });
  const open = (id: number) => go(target(id));
  const sentinel = useAutoLoad(query);
  useRowKeys(
    rows.map((row) => row.id),
    search.c,
    open,
  );
  return (
    <nav className="list" aria-label="会话列表">
      <FilterBar search={search} go={go} conversations />
      {query.isPending ? (
        <Loading label="正在读取会话…" />
      ) : query.isError && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        hasFilters(search) ? (
          <EmptyState title="没有符合条件的会话">换个筛选条件，或清除筛选。</EmptyState>
        ) : (
          <EmptyState title="还没有收到记录">
            启用 new-api 里的 ContextLedger 插件后，新请求会出现在这里。
          </EmptyState>
        )
      ) : (
        <ul className="rows">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to="/"
                activeOptions={{ exact: true }}
                search={target(row.id)}
                className="row"
                aria-current={search.c === row.id ? 'true' : undefined}
              >
                <span className="row-title">{row.title || '（无标题）'}</span>
                <span className="row-meta">
                  <span>{row.user || '未知用户'}</span>
                  <span>{row.models[0] ?? '未知模型'}</span>
                  <span>{row.ownTurns} 轮</span>
                  <span>{when(row.lastAt)}</span>
                  {row.subagentOf && (
                    <span className="tag lineage">
                      子代理{row.agentName ? ` · ${row.agentName}` : ''} · 由 #{row.subagentOf.id}{' '}
                      启动
                    </span>
                  )}
                  {row.forkedFrom && (
                    <span className="tag lineage">分自会话 #{row.forkedFrom.id}</span>
                  )}
                  {row.branchCount > 0 && (
                    <span className="tag lineage">{row.branchCount} 个分支</span>
                  )}
                  {row.subagentCount > 0 && (
                    <span className="tag lineage">{row.subagentCount} 个子代理</span>
                  )}
                  {row.hasError && <span className="tag danger">有报错</span>}
                  {!row.hasError && row.hasPartial && <span className="tag warn">回复不完整</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div ref={sentinel.ref} className="sentinel">
        {query.isFetchingNextPage && <Loading label="正在读取更早的会话…" />}
        <ManualLoad sentinel={sentinel} />
      </div>
    </nav>
  );
}

const completenessLabel = { complete: '完整', partial: '回复不完整', error: '报错' } as const;

export function RequestList({ search, go }: { search: AppSearch; go: Navigate }) {
  const query = useInfiniteQuery(requestsQuery(search));
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const target = (row: (typeof rows)[number]) =>
    validateAppSearch(
      row.conversationId !== null
        ? { ...search, c: row.conversationId, t: row.turnIndex ?? undefined, r: row.recordId }
        : { ...search, c: undefined, t: undefined, r: row.recordId },
    );
  const open = (recordId: number) => {
    const row = rows.find((candidate) => candidate.recordId === recordId);
    if (row) go(target(row));
  };
  const sentinel = useAutoLoad(query);
  useRowKeys(
    rows.map((row) => row.recordId),
    search.r,
    open,
  );
  return (
    <nav className="list" aria-label="请求列表">
      <FilterBar search={search} go={go} conversations={false} />
      {query.isPending ? (
        <Loading label="正在读取请求…" />
      ) : query.isError && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={hasFilters(search) ? '没有符合条件的请求' : '还没有收到记录'}>
          {hasFilters(search) ? '换个筛选条件，或清除筛选。' : '启用插件后，新请求会出现在这里。'}
        </EmptyState>
      ) : (
        <ul className="rows">
          {rows.map((row) => (
            <li key={row.recordId}>
              <Link
                to="/"
                activeOptions={{ exact: true }}
                search={target(row)}
                className="row request-row"
                aria-current={search.r === row.recordId ? 'true' : undefined}
              >
                <span className="row-title mono" title={row.requestId}>
                  {shortId(row.requestId || '无请求编号', 8)}
                </span>
                <span className="row-meta">
                  <span>{when(row.receivedAt)}</span>
                  <span>{row.user || '未知用户'}</span>
                  <span>{row.model || '未知模型'}</span>
                  <span>
                    {count(row.inputTokens)} → {count(row.outputTokens)}
                  </span>
                  <span
                    className={`tag ${row.completeness === 'error' ? 'danger' : row.completeness === 'partial' ? 'warn' : 'quiet'}`}
                  >
                    {completenessLabel[row.completeness]}
                  </span>
                  {row.conversationId === null && <span className="tag quiet">不属于会话</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div ref={sentinel.ref} className="sentinel">
        {query.isFetchingNextPage && <Loading label="正在读取更早的请求…" />}
        <ManualLoad sentinel={sentinel} />
      </div>
    </nav>
  );
}
