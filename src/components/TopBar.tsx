import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import brandMark from '../assets/brand/contextledger-mark-128.png';
import { bytes, dateTime } from '../client/format';
import { lookupQuery, metricsQuery, uploadsQuery } from '../client/queries';
import type { AppSearch } from '../client/search';
import { modalOpen } from '../client/shortcuts';
import type { LookupCandidate } from '../conversation-contracts';
import { Icon } from './Icon';

type Navigate = (next: AppSearch) => void;

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

function SearchBox({ search, go }: { search: AppSearch; go: Navigate }) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [submitted, setSubmitted] = useState('');
  const lookup = useQuery({ ...lookupQuery(submitted), enabled: submitted.length > 0 });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.isComposing && !isTyping(event.target) && !modalOpen()) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openCandidate = (candidate: LookupCandidate) => {
    setSubmitted('');
    setDraft('');
    if (candidate.conversationId !== null)
      go({
        ...search,
        tab: undefined,
        c: candidate.conversationId,
        t: candidate.turnIndex ?? undefined,
        r: undefined,
      });
    else go({ ...search, tab: 'requests', c: undefined, t: undefined, r: candidate.recordId });
  };
  const latestOpen = useRef(openCandidate);
  latestOpen.current = openCandidate;
  const result = lookup.data;
  useEffect(() => {
    const only = result?.candidates;
    if (only?.length === 1 && only[0]) latestOpen.current(only[0]);
  }, [result]);
  const candidates = lookup.data?.candidates ?? [];
  const value = submitted;
  const showPanel = value && (lookup.isFetching || lookup.isError || candidates.length !== 1);
  return (
    <div className="search">
      <form
        className="search-field"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(draft.trim());
        }}
      >
        <Icon name="search" size={15} />
        <input
          ref={input}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (!event.target.value) setSubmitted('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft('');
              setSubmitted('');
              event.currentTarget.blur();
            }
          }}
          placeholder="粘贴请求编号，或输入用户、令牌、模型"
          aria-label="按请求编号查找，或按用户、令牌、模型筛选"
          spellCheck={false}
          autoComplete="off"
        />
        <kbd title="按 / 键聚焦搜索">/</kbd>
      </form>
      {showPanel && (
        <section className="search-panel" aria-label="查找结果">
          {lookup.isFetching ? (
            <p className="muted">正在查找请求编号…</p>
          ) : lookup.isError ? (
            <p className="danger">{lookup.error.message}</p>
          ) : candidates.length > 1 ? (
            <>
              <p className="muted">这个请求编号对应 {candidates.length} 条记录，选一条打开：</p>
              <ul>
                {candidates.map((candidate) => (
                  <li key={candidate.recordId}>
                    <button
                      type="button"
                      className="option"
                      onClick={() => openCandidate(candidate)}
                    >
                      {dateTime(candidate.receivedAt)} · 来源 {candidate.source}
                      {candidate.turnIndex ? ` · 第 ${candidate.turnIndex} 轮` : ' · 单条请求'}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="muted">
                没有找到请求编号「{value}
                」。它可能还没上传完，或已被容量清理删除。也可以按下面的条件筛选：
              </p>
              <ul>
                {(['user', 'token', 'model'] as const).map((key) => (
                  <li key={key}>
                    <button
                      type="button"
                      className="option"
                      onClick={() => {
                        setSubmitted('');
                        setDraft('');
                        go({ ...search, [key]: value });
                      }}
                    >
                      {{ user: '用户', token: '令牌', model: '模型' }[key]}是「{value}」
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function UploadIndicator() {
  const uploads = useQuery({ ...uploadsQuery, refetchInterval: 60_000 });
  const open = (uploads.data?.uploads ?? []).filter((upload) => upload.state === 'partial');
  if (!open.length) return null;
  return (
    <details className="uploads">
      <summary>{open.length} 个未完成上传</summary>
      <div className="uploads-panel">
        <p className="muted small">
          这些请求还没有传完。同一段对话的后续请求会继续补齐，超时未补齐的会被丢弃。
        </p>
        <ul>
          {open.slice(0, 20).map((upload) => (
            <li key={upload.upload_id}>
              <span>{dateTime(upload.created_at)}</span>
              <span className="mono">{upload.hint.context?.model ?? '未知模型'}</span>
              <span>
                缺 {upload.missing_count.toLocaleString()} 块 · {bytes(upload.missing_bytes)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function TopBar({
  search,
  go,
  refresh,
}: {
  search: AppSearch;
  go: Navigate;
  refresh: () => void;
}) {
  const metrics = useQuery(metricsQuery);
  const stats = metrics.data;
  return (
    <header className="topbar">
      <Link
        to="/"
        activeOptions={{ exact: true }}
        search={{}}
        className="brand"
        aria-label="ContextLedger 首页"
      >
        <img src={brandMark} alt="" width={28} height={28} />
        <span>ContextLedger</span>
      </Link>
      <fieldset className="tabs">
        <legend className="sr-only">列表</legend>
        <button
          type="button"
          aria-pressed={search.tab !== 'requests'}
          onClick={() => go({ ...search, tab: undefined, r: undefined })}
        >
          会话
        </button>
        <button
          type="button"
          aria-pressed={search.tab === 'requests'}
          onClick={() => go({ ...search, tab: 'requests', kind: undefined })}
        >
          请求
        </button>
      </fieldset>
      <SearchBox search={search} go={go} />
      <div className="top-status">
        <UploadIndicator />
        {stats && (
          <span className="quota" title={`共 ${stats.records.toLocaleString()} 条记录`}>
            {bytes(stats.allocated)} / {bytes(stats.max)}
            <meter min={0} max={stats.max} value={Math.min(stats.allocated, stats.max)} />
          </span>
        )}
        {stats?.pressure && <span className="danger small">空间紧张，新记录可能被拒绝</span>}
        <button type="button" className="icon-button" aria-label="刷新" onClick={refresh}>
          <Icon name="refresh" />
        </button>
      </div>
    </header>
  );
}
