import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { bytes, charge, dateTime, usage } from '../client/format';
import { recordViewQuery } from '../client/queries';
import type { RecordMeta } from '../contracts';
import type { RecordView } from '../view-contracts';
import { Feedback } from './Feedback';
import { Icon } from './Icon';

function Overview({ meta }: { meta: RecordMeta }) {
  const tokens = usage(meta.usage_json);
  return (
    <div className="overview">
      <div className="info-note">
        已校验拼装的网关上报内容。未上报的内容、原始模型请求与不可读上下文不在此证据范围内。
      </div>
      <h3>请求概况</h3>
      <dl className="meta-grid">
        <dt>接收时间</dt>
        <dd>{dateTime(meta.received_at)}</dd>
        <dt>模型</dt>
        <dd>{meta.model || '未知'}</dd>
        <dt>来源</dt>
        <dd>{meta.source}</dd>
        <dt>渠道 / 用户</dt>
        <dd>
          {meta.channel || '未知'} / {meta.user_label || '未知'}
        </dd>
        <dt>令牌</dt>
        <dd>{meta.token_label || '未知'}</dd>
        <dt>耗时</dt>
        <dd>{meta.duration_ms === null ? '未知' : `${meta.duration_ms.toLocaleString()} ms`}</dd>
        <dt>输入 / 输出</dt>
        <dd>
          {tokens.input} / {tokens.output} tokens
        </dd>
        <dt>缓存 / 总用量</dt>
        <dd>
          {tokens.cache} / {tokens.total} tokens
        </dd>
        <dt>网关计费</dt>
        <dd>{charge(meta.cost_json)}</dd>
        <dt>上游采购成本</dt>
        <dd>未知</dd>
        <dt>网关捕获</dt>
        <dd>
          {meta.truncated ? '网关已截断，部分内容缺失' : '网关未报告截断'}
          {meta.media ? ' · 内联媒体已遮罩' : ''}
        </dd>
        <dt>存储方式</dt>
        <dd>{meta.storage_mode}</dd>
        <dt>拼装大小</dt>
        <dd>
          {bytes(meta.body_length)}（{meta.body_length.toLocaleString()} bytes）
        </dd>
      </dl>
      <p className="muted small">
        输入中的媒体只展示网关提供的格式、大小及位置描述；链接保持文本，不加载外部资源。捕获配置、剔除计数和生命周期残留请查看“捕获说明”。
      </p>
    </div>
  );
}
function NodeBrowser({
  view,
  open,
  previous,
  next,
}: {
  view: RecordView;
  open: (path: string[]) => void;
  previous: () => void;
  next: () => void;
}) {
  const container = view.node.kind === 'array' || view.node.kind === 'object';
  return (
    <div className="node-browser">
      <div className="node-caption">
        <span>{view.node.kind}</span>
        <span>
          {view.total.toLocaleString()}{' '}
          {view.node.kind === 'string' ? 'UTF-16 字符' : container ? '项' : ''}
        </span>
      </div>
      {container ? (
        view.entries.length ? (
          <div className="node-entries">
            {view.entries.map((entry, index) => (
              <button
                type="button"
                className="node-entry"
                key={entry.path ? JSON.stringify(entry.path) : `unavailable:${view.offset + index}`}
                disabled={!entry.path}
                onClick={() => entry.path && open(entry.path)}
              >
                <span className="entry-heading">
                  <strong>{entry.key}</strong>
                  <span className="entry-kind">
                    {entry.kind}
                    {entry.count > 0
                      ? ` · ${entry.count.toLocaleString()}${entry.kind === 'string' ? ' 字符' : ' 项'}`
                      : ''}
                  </span>
                  <Icon name="right" size={14} />
                </span>
                {entry.preview && <code>{entry.preview}</code>}
                {entry.unavailable && (
                  <span className="warning-text">
                    {entry.unavailable === 'key_limit'
                      ? '键名超出安全查看长度'
                      : '路径超出安全查看深度'}
                    ，此项无法继续展开
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-node">此容器为空。</p>
        )
      ) : (
        <pre className="evidence-text">{view.text ?? view.node.preview}</pre>
      )}
      {(view.offset > 0 || view.nextOffset !== null) && (
        <div className="pager">
          <button type="button" disabled={view.offset === 0} onClick={previous}>
            <Icon name="left" size={12} /> 上一页
          </button>
          <span>
            {view.offset.toLocaleString()}–{(view.nextOffset ?? view.total).toLocaleString()} /{' '}
            {view.total.toLocaleString()}
          </span>
          <button type="button" disabled={view.nextOffset === null} onClick={next}>
            下一页 <Icon name="right" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
export function RecordInspector({ id, close }: { id: number; close: () => void }) {
  const client = useQueryClient();
  const [location, setLocation] = useState<{ tab: string; path: string[]; offsets: number[] }>({
    tab: 'overview',
    path: [],
    offsets: [0],
  });
  const offset = location.offsets.at(-1) ?? 0;
  const root = useQuery(recordViewQuery(id, [], 0));
  const query = useQuery(recordViewQuery(id, location.path, offset));
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: ['record-view', id] });
      client.removeQueries({ queryKey: ['record-view', id] });
    },
    [client, id],
  );
  const view = query.data;
  const summary = root.data ?? view;
  const open = (path: string[]) => setLocation((previous) => ({ ...previous, path, offsets: [0] }));
  return (
    <aside className="inspector" aria-label="请求详情">
      <div className="inspector-header">
        <div>
          <span className="eyebrow">
            请求详情 <span>#{id}</span>
          </span>
          <h2>{summary?.meta.model || '请求详情'}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={close}>
          <Icon name="close" size={20} />
        </button>
      </div>
      {summary && (
        <>
          <p className="request-id" title={summary.meta.host_request_id}>
            {summary.meta.host_request_id || '无网关请求 ID'}
          </p>
          <div className="detail-status">
            <span className={`pill ${summary.meta.outcome === 'error' ? 'danger' : 'success'}`}>
              {summary.meta.outcome === 'error' ? '上报错误' : '已接收'}
            </span>
            {summary.meta.truncated ? <span className="pill warning">网关截断</span> : null}
            <span>{dateTime(summary.meta.received_at)}</span>
          </div>
        </>
      )}
      <nav className="detail-tabs" aria-label="详情分区">
        <button
          type="button"
          className={location.tab === 'overview' ? 'active' : ''}
          onClick={() => setLocation({ tab: 'overview', path: [], offsets: [0] })}
        >
          概览
        </button>
        {summary?.sections.map((section) => (
          <button
            type="button"
            key={section.id}
            className={location.tab === section.id ? 'active' : ''}
            onClick={() => setLocation({ tab: section.id, path: section.path, offsets: [0] })}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <div className="inspector-content">
        {query.isPending ? (
          <p className="loading" role="status">
            正在读取这一页内容…
          </p>
        ) : query.isError ? (
          <Feedback error={query.error} retry={() => void query.refetch()} />
        ) : view ? (
          location.tab === 'overview' ? (
            <Overview meta={view.meta} />
          ) : (
            <>
              <nav className="breadcrumbs" aria-label="JSON 路径">
                <button type="button" onClick={() => open([])}>
                  根
                </button>
                {location.path.map((segment, index) => (
                  <span key={JSON.stringify(location.path.slice(0, index + 1))}>
                    <span aria-hidden="true"> / </span>
                    <button type="button" onClick={() => open(location.path.slice(0, index + 1))}>
                      {segment}
                    </button>
                  </span>
                ))}
              </nav>
              {location.tab === 'capture' && (
                <p className="info-note">
                  此处保留可读化配置、剔除统计、事件覆盖和生命周期残留；仅表示实际收到的捕获信息。
                </p>
              )}
              {location.tab === 'events' && (
                <p className="info-note">
                  只展示实际保留的事件。已被最终结果覆盖的事件可能已按捕获规则剔除。
                </p>
              )}
              {location.tab === 'request' && (
                <p className="info-note">
                  包含已提交输入、历史及可用媒体描述。图片与链接均以文本展示。
                </p>
              )}
              <NodeBrowser
                view={view}
                open={open}
                previous={() =>
                  setLocation((previous) => ({
                    ...previous,
                    offsets: previous.offsets.slice(0, -1),
                  }))
                }
                next={() => {
                  if (view.nextOffset !== null)
                    setLocation((previous) => ({
                      ...previous,
                      offsets: [...previous.offsets, view.nextOffset as number],
                    }));
                }}
              />
            </>
          )
        ) : null}
      </div>
      {summary && (
        <div className="integrity">
          <span>拼装内容 SHA-256</span>
          <code>{summary.meta.body_hash}</code>
        </div>
      )}
    </aside>
  );
}
