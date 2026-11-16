import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import brandMark from '../assets/brand/contextledger-mark-v2.png';
import { bytes, charge, dateTime, usage } from '../client/format';
import { metricsQuery, recordsQuery, uploadsQuery } from '../client/queries';
import { validateDashboardSearch } from '../client/search';
import { Empty, Feedback } from '../components/Feedback';
import { Filters } from '../components/Filters';
import { Icon } from '../components/Icon';
import { RecordInspector } from '../components/RecordInspector';
import { Uploads } from '../components/Uploads';
export const Route = createFileRoute('/')({
  ssr: false,
  validateSearch: validateDashboardSearch,
  component: Dashboard,
});
function Dashboard() {
  const search = Route.useSearch(),
    navigate = Route.useNavigate(),
    client = useQueryClient();
  const records = useInfiniteQuery({ ...recordsQuery(search), enabled: search.view !== 'uploads' });
  const metrics = useQuery(metricsQuery);
  const uploads = useQuery({ ...uploadsQuery, enabled: search.view === 'uploads' });
  const rows = records.data?.pages.flatMap((page) => page.rows) ?? [];
  const stats = metrics.data;
  const select = (id: number) =>
    void navigate({ search: (previous) => ({ ...previous, selected: id, view: undefined }) });
  const refresh = () => {
    void client.resetQueries({ queryKey: ['records'] });
    void client.invalidateQueries({ queryKey: ['metrics'] });
    void client.invalidateQueries({ queryKey: ['uploads'] });
    if (search.selected)
      void client.invalidateQueries({ queryKey: ['record-view', search.selected] });
  };
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="ContextLedger 首页">
          <img className="brand-mark" src={brandMark} alt="" width={38} height={38} />
          <span>ContextLedger</span>
        </a>
        <nav className="top-tabs" aria-label="主导航">
          <button
            type="button"
            className={!search.view ? 'active' : ''}
            onClick={() =>
              void navigate({ search: (previous) => ({ ...previous, view: undefined }) })
            }
          >
            请求记录
          </button>
          <button
            type="button"
            className={search.view === 'uploads' ? 'active' : ''}
            onClick={() =>
              void navigate({
                search: (previous) => ({ ...previous, view: 'uploads', selected: undefined }),
              })
            }
          >
            传输状态
          </button>
        </nav>
        <div className="top-actions">
          <span className="admin">管理员</span>
          <button type="button" onClick={refresh}>
            <Icon name="refresh" /> <span>刷新</span>
          </button>
        </div>
      </header>
      <div className="storage-strip">
        {stats ? (
          <>
            <span>
              已保留 <strong>{stats.records.toLocaleString()}</strong> 条
            </span>
            <span className="storage-number">
              存储 <strong>{bytes(stats.allocated)}</strong> / {bytes(stats.max)}
            </span>
            <meter
              min={0}
              max={stats.max}
              value={Math.min(stats.allocated, stats.max)}
              aria-label="存储配额使用量"
            />
            <details className="storage-extra">
              <summary>存储明细</summary>
              <div>
                活跃页 {bytes(stats.live)} · 可复用 {bytes(stats.reusable)} · WAL {bytes(stats.wal)}
                <br />
                已共享对象 {stats.objects.toLocaleString()} · 逻辑大小 {bytes(stats.logical)}
              </div>
            </details>
          </>
        ) : metrics.isError ? (
          <span className="error" role="alert">
            存储信息读取失败{' '}
            <button type="button" className="text-button" onClick={() => void metrics.refetch()}>
              重试
            </button>
          </span>
        ) : (
          <span role="status">正在读取存储信息…</span>
        )}
      </div>
      <main>
        <div className="page-heading">
          <h1>{search.view === 'uploads' ? '传输状态' : '请求记录'}</h1>
          <p>仅展示网关已上报的内容。</p>
        </div>
        {stats?.pressure && (
          <p className="info-note warning-text" role="alert">
            存储压力：{stats.pressure}。新写入可能被拒绝。
          </p>
        )}
        {search.view === 'uploads' ? (
          <>
            {uploads.isPending ? (
              <div className="surface loading" role="status">
                正在读取传输状态…
              </div>
            ) : uploads.isError ? (
              <Feedback error={uploads.error} retry={() => void uploads.refetch()} />
            ) : (
              <Uploads uploads={uploads.data.uploads} select={select} />
            )}
          </>
        ) : (
          <>
            <Filters search={search} apply={(value) => void navigate({ search: value })} />
            <div className={`workspace ${search.selected ? 'with-inspector' : ''}`}>
              <section className="records-panel" aria-label="请求记录">
                <div className="list-caption">
                  <span>{rows.length ? `当前显示 ${rows.length} 条` : '接收记录'}</span>
                  <span>按接收顺序 · 最新优先</span>
                </div>
                {records.isError ? (
                  <Feedback error={records.error} retry={() => void records.refetch()} />
                ) : null}
                {records.isPending ? (
                  <div className="loading" role="status">
                    正在读取请求记录…
                  </div>
                ) : rows.length ? (
                  <>
                    <div className="table-wrap">
                      <table className="records-table">
                        <thead>
                          <tr>
                            <th>接收时间</th>
                            <th>模型 / 请求 ID</th>
                            <th>用量 / 计费</th>
                            <th>状态 / 捕获</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => {
                            const tokens = usage(row.usage_json);
                            return (
                              <tr
                                key={row.id}
                                className={search.selected === row.id ? 'selected' : ''}
                              >
                                <td>
                                  <button
                                    type="button"
                                    className="row-open"
                                    aria-label={`查看记录 ${row.id}`}
                                    onClick={() => select(row.id)}
                                  >
                                    {dateTime(row.received_at)}
                                    <small>#{row.id}</small>
                                  </button>
                                </td>
                                <td>
                                  <strong className="model-name">{row.model || '未知模型'}</strong>
                                  <code className="table-id" title={row.host_request_id}>
                                    {row.host_request_id || '无网关请求 ID'}
                                  </code>
                                  <small>
                                    {row.channel ? `渠道 ${row.channel}` : '未知渠道'} ·{' '}
                                    {row.duration_ms === null
                                      ? '耗时未知'
                                      : `${row.duration_ms.toLocaleString()} ms`}
                                  </small>
                                </td>
                                <td>
                                  <span className="token-line">输入 {tokens.input}</span>
                                  <span className="token-line">输出 {tokens.output}</span>
                                  <small>网关 {charge(row.cost_json)}</small>
                                </td>
                                <td>
                                  <span
                                    className={`pill ${row.outcome === 'error' ? 'danger' : 'success'}`}
                                  >
                                    {row.outcome === 'error' ? '上报错误' : '已接收'}
                                  </span>
                                  {row.truncated ? (
                                    <small className="warning-text">网关截断</small>
                                  ) : (
                                    <small>未报告截断</small>
                                  )}
                                  {row.media ? <small>媒体已遮罩</small> : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="list-footer">
                      {records.hasNextPage ? (
                        <button
                          type="button"
                          disabled={records.isFetchingNextPage}
                          onClick={() => void records.fetchNextPage()}
                        >
                          {records.isFetchingNextPage ? (
                            '正在读取…'
                          ) : (
                            <>
                              加载更早记录 <Icon name="down" size={14} />
                            </>
                          )}
                        </button>
                      ) : (
                        <span>已到当前筛选的最早记录</span>
                      )}
                      <small>每次 25 条，最多展示 100 条；刷新回到最新记录。</small>
                    </div>
                  </>
                ) : !records.isError ? (
                  <Empty title="暂无请求记录">
                    {Object.keys(search).some((key) => key !== 'selected')
                      ? '没有符合筛选条件的记录。可重置筛选后重试。'
                      : '收到并校验拼装的上报后，记录会出现在这里。'}
                  </Empty>
                ) : null}
              </section>
              {search.selected ? (
                <RecordInspector
                  key={search.selected}
                  id={search.selected}
                  close={() =>
                    void navigate({ search: (previous) => ({ ...previous, selected: undefined }) })
                  }
                />
              ) : (
                <aside className="inspector inspector-placeholder">
                  <Empty title="选择一条请求">点击接收时间，查看已上报的请求内容。</Empty>
                  <p className="small muted">分段读取内容 · 无外部媒体加载</p>
                </aside>
              )}
            </div>
          </>
        )}
        <footer>
          上报记录可能受网关捕获限制与上传丢失影响。网关计费按上报展示，上游采购成本未知。
        </footer>
      </main>
    </>
  );
}
