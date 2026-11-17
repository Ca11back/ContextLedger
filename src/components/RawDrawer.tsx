import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { recordViewQuery } from '../client/queries';
import type { RecordView } from '../view-contracts';
import { ErrorState } from './Feedback';
import { Icon } from './Icon';

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
    <div className="raw-node">
      <p className="raw-caption">
        {view.node.kind} · {view.total.toLocaleString()}
        {view.node.kind === 'string' ? ' 个字符' : container ? ' 项' : ''}
      </p>
      {container ? (
        view.entries.length ? (
          <ul className="raw-entries">
            {view.entries.map((entry, index) => (
              <li key={entry.path ? JSON.stringify(entry.path) : `x${view.offset + index}`}>
                <button
                  type="button"
                  disabled={!entry.path}
                  onClick={() => entry.path && open(entry.path)}
                >
                  <span className="raw-key">{entry.key}</span>
                  <span className="raw-kind">
                    {entry.kind}
                    {entry.count > 0 ? ` · ${entry.count.toLocaleString()}` : ''}
                  </span>
                  {entry.preview && <code>{entry.preview}</code>}
                  {entry.unavailable && <span className="warn">超出可查看范围</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">空。</p>
        )
      ) : (
        <pre className="raw-text">{view.text ?? view.node.preview}</pre>
      )}
      {(view.offset > 0 || view.nextOffset !== null) && (
        <div className="raw-pager">
          <button type="button" className="ghost" disabled={view.offset === 0} onClick={previous}>
            上一页
          </button>
          <span>
            {view.offset.toLocaleString()}–{(view.nextOffset ?? view.total).toLocaleString()} /{' '}
            {view.total.toLocaleString()}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={view.nextOffset === null}
            onClick={next}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

/** Bounded raw-data browser for one stored record, reused from the earlier inspector. */
export function RawBrowser({ recordId }: { recordId: number }) {
  const client = useQueryClient();
  const [location, setLocation] = useState<{ path: string[]; offsets: number[] }>({
    path: [],
    offsets: [0],
  });
  const offset = location.offsets.at(-1) ?? 0;
  const query = useQuery(recordViewQuery(recordId, location.path, offset));
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: ['record-view', recordId] });
      client.removeQueries({ queryKey: ['record-view', recordId] });
    },
    [client, recordId],
  );
  const open = (path: string[]) => setLocation({ path, offsets: [0] });
  return (
    <div className="raw-browser">
      <nav className="raw-path" aria-label="数据路径">
        <button type="button" className="link" onClick={() => open([])}>
          全部
        </button>
        {location.path.map((segment, index) => (
          <span key={JSON.stringify(location.path.slice(0, index + 1))}>
            {' / '}
            <button
              type="button"
              className="link"
              onClick={() => open(location.path.slice(0, index + 1))}
            >
              {segment}
            </button>
          </span>
        ))}
      </nav>
      {query.isPending ? (
        <p className="muted" role="status">
          正在读取…
        </p>
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <NodeBrowser
          view={query.data}
          open={open}
          previous={() =>
            setLocation((previous) => ({ ...previous, offsets: previous.offsets.slice(0, -1) }))
          }
          next={() => {
            const next = query.data.nextOffset;
            if (next !== null)
              setLocation((previous) => ({ ...previous, offsets: [...previous.offsets, next] }));
          }}
        />
      )}
    </div>
  );
}

export function RawDrawer({
  recordId,
  title,
  close,
}: {
  recordId: number;
  title: string;
  close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnTo?.focus();
    };
  }, [close]);
  return (
    <div className="drawer-backdrop">
      <button type="button" className="drawer-scrim" aria-label="关闭原始数据" onClick={close} />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭原始数据" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <p className="muted small">
          这是收到并校验过的原始上报内容，按层级分页查看。文字均按纯文本显示，不加载任何外部资源。
        </p>
        <RawBrowser recordId={recordId} />
      </div>
    </div>
  );
}
