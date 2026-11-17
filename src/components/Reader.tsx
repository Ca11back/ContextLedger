import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { charge, clock, count, dateTime, duration, shortId, tokens } from '../client/format';
import { conversationQuery, fragmentsQuery, recordViewQuery } from '../client/queries';
import type { AppSearch } from '../client/search';
import { useSentinel } from '../client/sentinel';
import { buildTranscript, type TurnView } from '../client/transcript';
import type { ConversationDetail } from '../conversation-contracts';
import { EmptyState, ErrorState, Loading } from './Feedback';
import { Icon } from './Icon';
import { LeadingHistory, Message } from './Message';
import { RawBrowser, RawDrawer } from './RawDrawer';

type Navigate = (next: AppSearch) => void;

const resetText = {
  window_changed: '上下文在这里发生了变化（客户端换了上下文窗口，常见于压缩）',
  no_prefix: '上下文在这里发生了变化（无法和前面的内容对上）',
} as const;

function useFragments(id: number, startTurn: number | undefined, untilTurn?: number) {
  const query = useInfiniteQuery(fragmentsQuery(id, startTurn));
  const fragments = useMemo(
    () => query.data?.pages.flatMap((page) => page.fragments) ?? [],
    [query.data],
  );
  const { turns, lastSeen } = useMemo(() => {
    const all = buildTranscript(fragments);
    const lastSeen = all.at(-1)?.turn.turnIndex ?? 0;
    return {
      lastSeen,
      turns: untilTurn === undefined ? all : all.filter((turn) => turn.turn.turnIndex <= untilTurn),
    };
  }, [fragments, untilTurn]);
  return { query, turns, lastSeen };
}

export function TurnBlock({
  view,
  anchored,
  openRaw,
  spurs,
  go,
  search,
  streamOpen = false,
}: {
  view: TurnView;
  anchored: boolean;
  openRaw: (recordId: number, title: string) => void;
  spurs: { id: number; title: string }[];
  go: Navigate;
  search: AppSearch;
  /** The fragments stream may still continue this turn (last turn received, more pages). */
  streamOpen?: boolean;
}) {
  const { turn } = view;
  // Only the last message received can still get its first chunks; the stream is ordered.
  const pendingId = streamOpen ? view.messages.at(-1)?.messageId : undefined;
  const carried = view.messages.filter((message) => message.leadingHistory);
  const own = view.messages.filter((message) => !message.leadingHistory);
  const node = useRef<HTMLElement>(null);
  useEffect(() => {
    if (anchored) node.current?.scrollIntoView({ block: 'start' });
  }, [anchored]);
  const [copied, setCopied] = useState(false);
  return (
    <>
      {view.reset && (
        <div className="reset" role="note">
          {resetText[view.reset]}
        </div>
      )}
      <article
        ref={node}
        id={`turn-${turn.turnIndex}`}
        className={`turn${anchored ? ' anchored' : ''}${turn.superseded ? ' superseded' : ''}`}
        aria-label={`第 ${turn.turnIndex} 轮${anchored ? '，搜索命中' : ''}`}
      >
        <div className="rail" aria-hidden="true">
          <span className="node">{turn.turnIndex}</span>
        </div>
        <div className="turn-body">
          <div className="turn-head">
            <strong className="turn-label">第 {turn.turnIndex} 轮</strong>
            {anchored && <span className="found">请求编号命中</span>}
            <span>{clock(turn.receivedAt)}</span>
            <button
              type="button"
              className="request-id mono"
              title={`${turn.requestId}（点击复制）`}
              onClick={() => {
                void navigator.clipboard?.writeText(turn.requestId).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? '已复制' : shortId(turn.requestId || '无请求编号')}
            </button>
            <span>{tokens(turn.inputTokens, turn.outputTokens)}</span>
            <span>{duration(turn.durationMs)}</span>
            {turn.model && <span>{turn.model}</span>}
            {turn.stopReason && <span title="模型给出的停止原因">停止原因 {turn.stopReason}</span>}
            {turn.retryOf ? <span className="tag quiet">重试第 {turn.retryOf} 轮</span> : null}
            {turn.completeness === 'partial' && <span className="tag warn">回复不完整</span>}
            {turn.completeness === 'error' && <span className="tag danger">报错</span>}
            <button
              type="button"
              className="link raw-link"
              onClick={() => openRaw(turn.recordId, `第 ${turn.turnIndex} 轮的原始数据`)}
            >
              原始数据
            </button>
          </div>
          {turn.parentOutputIncomplete && (
            <p className="note">
              上一轮的回复没有完整采集。如果客户端在这次请求里带上了它收到的回复，会出现在下面开头，可能和上一轮重复。
            </p>
          )}
          {carried.length > 0 && (
            <LeadingHistory
              messages={carried}
              label={view.reset ? '变化后的上下文' : '首条请求携带的历史'}
              pendingId={pendingId}
            />
          )}
          {own.map((message) => (
            <Message
              key={message.messageId}
              message={message}
              pending={message.messageId === pendingId}
            />
          ))}
          {turn.superseded ? (
            <p className="note">
              {turn.completeness === 'error'
                ? '这次请求失败，'
                : turn.completeness === 'partial'
                  ? '这次回复没有完整采集，'
                  : ''}
              客户端在后面用同样的内容重试了。
            </p>
          ) : (
            <>
              {turn.completeness === 'partial' && (
                <p className="note">
                  回复没有完整采集。如果客户端在后续请求里带上了它收到的回复，会出现在下一轮开头。
                </p>
              )}
              {turn.completeness === 'error' &&
                own.every((message) => message.side === 'input') && (
                  <p className="note">这次请求报错，没有收到回复内容。详情见原始数据。</p>
                )}
            </>
          )}
        </div>
      </article>
      {spurs.map((spur) => (
        <div className="spur" key={spur.id}>
          <div className="rail" aria-hidden="true">
            <span className="bend" />
          </div>
          <p>
            此处分出{' '}
            <button
              type="button"
              className="link"
              onClick={() => go({ ...search, c: spur.id, t: undefined, r: undefined })}
            >
              会话 #{spur.id}「{spur.title || '无标题'}」
            </button>
          </p>
        </div>
      ))}
    </>
  );
}

function InheritedTurns({
  detail,
  go,
  search,
  openRaw,
}: {
  detail: ConversationDetail;
  go: Navigate;
  search: AppSearch;
  openRaw: (recordId: number, title: string) => void;
}) {
  const source = detail.forkedFrom;
  const [open, setOpen] = useState(false);
  if (!source) return null;
  if (source.removed)
    return (
      <div className="inherited">
        <span>前 {source.turn} 轮来自另一段会话，来源已被容量清理删除。</span>
      </div>
    );
  return (
    <div className="inherited-wrap">
      <div className="inherited">
        <span>
          前 {source.turn} 轮来自会话 #{source.id}，已折叠（时间、用量、费用都算在会话 #{source.id}
          ）
        </span>
        <span className="inherited-actions">
          <button type="button" className="link small" onClick={() => setOpen(!open)}>
            {open ? '收起' : `展开前 ${source.turn} 轮`}
          </button>
          <button
            type="button"
            className="link small"
            onClick={() => go({ ...search, c: source.id, t: source.turn, r: undefined })}
          >
            打开会话 #{source.id}
          </button>
        </span>
      </div>
      {open && (
        <InheritedBody
          id={source.id}
          until={source.turn}
          openRaw={openRaw}
          go={go}
          search={search}
        />
      )}
    </div>
  );
}

function InheritedBody({
  id,
  until,
  openRaw,
  go,
  search,
}: {
  id: number;
  until: number;
  openRaw: (recordId: number, title: string) => void;
  go: Navigate;
  search: AppSearch;
}) {
  const { query, turns, lastSeen } = useFragments(id, undefined, until);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;
  // Keep reading until a turn after `until` appears, so the last inherited turn is complete.
  const more = lastSeen <= until && hasNextPage;
  useEffect(() => {
    if (more && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [more, isFetching, isFetchNextPageError, fetchNextPage]);
  if (query.isPending) return <Loading label="正在载入继承的轮次…" />;
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <div className="inherited-body">
      {turns.map((view, index) => (
        <TurnBlock
          key={view.turn.turnIndex}
          view={view}
          anchored={false}
          openRaw={openRaw}
          spurs={[]}
          go={go}
          search={search}
          streamOpen={more && index === turns.length - 1}
        />
      ))}
      {more && isFetchNextPageError && !isFetching && (
        <button type="button" className="link small load-more" onClick={() => void fetchNextPage()}>
          继续载入
        </button>
      )}
    </div>
  );
}

function Header({
  detail,
  go,
  search,
}: {
  detail: ConversationDetail;
  go: Navigate;
  search: AppSearch;
}) {
  const c = detail.conversation;
  const open = (id: number) => go({ ...search, c: id, t: undefined, r: undefined });
  return (
    <section className="reader-head">
      <button
        type="button"
        className="link back"
        onClick={() => go({ ...search, c: undefined, t: undefined, r: undefined })}
      >
        <Icon name="left" size={14} /> {search.tab === 'requests' ? '请求列表' : '会话列表'}
      </button>
      <h1>{c.title || '（无标题）'}</h1>
      <p className="facts">
        <span>
          用户 <b>{c.user || '未知'}</b>
        </span>
        <span>
          令牌 <b>{c.token || '未知'}</b>
        </span>
        <span>
          模型 <b>{c.models.join('、') || '未知'}</b>
          {c.moreModels ? ' 等' : ''}
        </span>
        <span>
          <b>{c.ownTurns}</b> 轮{c.inheritedTurns ? `（另继承 ${c.inheritedTurns} 轮）` : ''}
        </span>
        <span>
          输入 <b>{count(c.inputTokens)}</b> · 输出 <b>{count(c.outputTokens)}</b> tokens
        </span>
        <span>{charge(c.charge, c.chargePartial)}</span>
        <span>
          {dateTime(c.firstAt)} – {clock(c.lastAt)}
        </span>
      </p>
      {detail.subagentOf && (
        <p className="banner">
          <Icon name="agent" />
          <span>
            子代理{c.agentName ? `「${c.agentName}」` : ''}，
            {detail.subagentOf.removed ? (
              '启动它的会话已被容量清理删除'
            ) : (
              <>
                由{' '}
                <button type="button" className="link" onClick={() => open(detail.subagentOf!.id)}>
                  会话 #{detail.subagentOf.id}「{detail.subagentOf.title ?? '无标题'}」
                </button>{' '}
                启动
              </>
            )}
            （客户端声明）。
          </span>
        </p>
      )}
      {detail.forkedFrom && !detail.forkedFrom.removed && (
        <p className="banner">
          <Icon name="fork" />
          <span>
            从{' '}
            <button type="button" className="link" onClick={() => open(detail.forkedFrom!.id)}>
              会话 #{detail.forkedFrom.id}「{detail.forkedFrom.title ?? '无标题'}」
            </button>{' '}
            第 {detail.forkedFrom.turn} 轮分出。
          </span>
        </p>
      )}
      {detail.subagentCount > 0 && detail.subagentsPreview.length > 0 && (
        <p className="agents">
          这段会话启动了 {detail.subagentCount} 个子代理（客户端声明）：
          {detail.subagentsPreview.map((agent, index) => (
            <span key={agent.id}>
              {index > 0 && '、'}
              <button type="button" className="link" onClick={() => open(agent.id)}>
                {agent.agentName ?? `会话 #${agent.id}`}
              </button>
            </span>
          ))}
          {detail.subagentCount > detail.subagentsPreview.length && ' 等'}
        </p>
      )}
    </section>
  );
}

export function ConversationReader({
  id,
  search,
  go,
}: {
  id: number;
  search: AppSearch;
  go: Navigate;
}) {
  const detail = useQuery(conversationQuery(id));
  const [start, setStart] = useState<number | undefined>(search.t);
  useEffect(() => setStart(search.t), [search.t]);
  const { query, turns } = useFragments(id, start);
  const [raw, setRaw] = useState<{ recordId: number; title: string } | null>(null);
  const openRaw = useCallback((recordId: number, title: string) => setRaw({ recordId, title }), []);
  const closeRaw = useCallback(() => setRaw(null), []);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadNext = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  // Callback-ref sentinel: attaches when the node mounts, even if detail resolves after fragments.
  const sentinel = useSentinel({
    hasNextPage,
    isFetching: query.isFetching,
    failed: query.isFetchNextPageError,
    load: loadNext,
  });
  // [ and ] jump between turns outside text inputs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== '[' && event.key !== ']') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      )
        return;
      const nodes = [...document.querySelectorAll<HTMLElement>('.reader .turn')];
      // First turn below the reading line; the current turn is the one before it.
      const found = nodes.findIndex((node) => node.getBoundingClientRect().top > 80);
      const index = found === -1 ? nodes.length : found;
      const next = event.key === ']' ? nodes[Math.min(index, nodes.length - 1)] : nodes[index - 2];
      next?.scrollIntoView({ block: 'start' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const spursAt = useMemo(() => {
    const map = new Map<number, { id: number; title: string }[]>();
    for (const branch of detail.data?.branchesPreview ?? [])
      map.set(branch.atTurn, [...(map.get(branch.atTurn) ?? []), branch]);
    return map;
  }, [detail.data]);
  if (detail.isPending) return <Loading label="正在打开会话…" />;
  if (detail.isError)
    return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const first = turns[0]?.turn.turnIndex;
  return (
    <>
      <Header detail={detail.data} go={go} search={search} />
      <div className="thread">
        {(!first || first === 1) && (
          <InheritedTurns detail={detail.data} go={go} search={search} openRaw={openRaw} />
        )}
        {first !== undefined && first > 1 && (
          <button
            type="button"
            className="ghost earlier"
            onClick={() => setStart(Math.max(1, first - 20))}
          >
            载入前面的轮次（从第 {Math.max(1, first - 20)} 轮开始）
          </button>
        )}
        {query.isPending ? (
          <Loading label="正在载入对话内容…" />
        ) : query.isError && !query.data ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : turns.length === 0 ? (
          <EmptyState title="这段会话没有可显示的内容" />
        ) : (
          turns.map((view, index) => (
            <TurnBlock
              key={view.turn.turnIndex}
              view={view}
              anchored={search.t === view.turn.turnIndex}
              openRaw={openRaw}
              spurs={spursAt.get(view.turn.turnIndex) ?? []}
              go={go}
              search={search}
              streamOpen={hasNextPage && index === turns.length - 1}
            />
          ))
        )}
        <div ref={sentinel.ref} className="sentinel">
          {isFetchingNextPage && <Loading label="正在载入后面的内容…" />}
          {sentinel.showManual && (
            <button type="button" className="link small load-more" onClick={loadNext}>
              继续载入
            </button>
          )}
          {!hasNextPage && turns.length > 0 && <p className="end">会话到这里结束。</p>}
        </div>
      </div>
      {raw && <RawDrawer recordId={raw.recordId} title={raw.title} close={closeRaw} />}
    </>
  );
}

export function RequestReader({
  recordId,
  search,
  go,
}: {
  recordId: number;
  search: AppSearch;
  go: Navigate;
}) {
  const root = useQuery(recordViewQuery(recordId, [], 0));
  const meta = root.data?.meta;
  return (
    <>
      <section className="reader-head">
        <button type="button" className="link back" onClick={() => go({ ...search, r: undefined })}>
          <Icon name="left" size={14} /> 请求列表
        </button>
        <h1>{meta ? meta.model || '未知模型' : '单条请求'}</h1>
        {meta && (
          <p className="facts">
            <span>{dateTime(meta.received_at)}</span>
            <span className="mono" title={meta.host_request_id}>
              {shortId(meta.host_request_id || '无请求编号', 10)}
            </span>
            <span>
              用户 <b>{meta.user_label || '未知'}</b>
            </span>
            <span>
              令牌 <b>{meta.token_label || '未知'}</b>
            </span>
          </p>
        )}
        <p className="note">
          这条请求不是对话格式（例如搜索、图片或音频），不属于任何会话，只能查看原始数据。
        </p>
      </section>
      <div className="thread">
        {root.isError ? (
          <ErrorState error={root.error} retry={() => void root.refetch()} />
        ) : (
          <RawBrowser recordId={recordId} />
        )}
      </div>
    </>
  );
}
