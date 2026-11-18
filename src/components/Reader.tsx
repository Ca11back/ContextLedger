import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cacheHit,
  clock,
  cost,
  count,
  dateTime,
  duration,
  hitRate,
  incompleteLabel,
  partialChargeNote,
  searchOperationsSummary,
  shortId,
  tokens,
} from '../client/format';
import {
  conversationQuery,
  fragmentsQuery,
  recordViewQuery,
  requestQuery,
} from '../client/queries';
import {
  earlierRanges,
  earlierStart,
  initialStart,
  mainStart,
  type ReadingStart,
  useReadingPosition,
} from '../client/reading';
import { type AppSearch, validateAppSearch } from '../client/search';
import { useSentinel } from '../client/sentinel';
import { modalOpen } from '../client/shortcuts';
import { buildTranscript, type TurnView } from '../client/transcript';
import type { ConversationDetail, RequestRow } from '../conversation-contracts';
import { EmptyState, ErrorState, Loading } from './Feedback';
import { Icon } from './Icon';
import { LeadingHistory, MessageList } from './Message';
import { RawBrowser, RawDrawer } from './RawDrawer';
import { SearchOperations } from './Search';

/** Search state for opening conversation `c` (optionally at turn `t`) from the current view. */
function openAt(search: AppSearch, c: number, t?: number): AppSearch {
  return validateAppSearch({ ...search, c, t, r: undefined });
}

const resetText = {
  window_changed: '上下文在这里发生了变化（客户端换了上下文窗口，常见于压缩）',
  no_prefix: '上下文在这里发生了变化（无法和前面的内容对上）',
} as const;

function useFragments(
  id: number,
  startTurn: number | undefined,
  untilTurn?: number,
  mode: 'at' | 'from' = 'at',
  enabled = true,
) {
  const query = useInfiniteQuery({ ...fragmentsQuery(id, startTurn, mode), enabled });
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
  search,
  streamOpen = false,
}: {
  view: TurnView;
  anchored: boolean;
  openRaw: (recordId: number, title: string) => void;
  spurs: { id: number; title: string }[];
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
  // Failed and superseded attempts fold to their head; the next turn usually resends their
  // content. null = default (expanded only when this turn is the search hit).
  const foldable = turn.completeness === 'error' || turn.superseded === true;
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = !foldable || (toggled ?? anchored);
  const errorReason =
    turn.durationMs !== null && turn.durationMs >= 60_000
      ? `报错（${Math.round(turn.durationMs / 60_000)} 分钟后中断）`
      : '报错（请求失败）';
  const turnCost = cost(turn.charge, turn.chargeUsd);
  const turnCache = cacheHit(turn.cacheReadTokens, turn.inputTotalTokens);
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
        className={`turn${anchored ? ' anchored' : ''}${turn.superseded ? ' superseded' : ''}${expanded ? '' : ' collapsed'}`}
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
            {turnCost && (
              <span title="网关计费，非上游成本" className="cost">
                {turnCost}
              </span>
            )}
            {turnCache && (
              <span
                title={`缓存写入 ${count(turn.cacheWriteTokens ?? null)} · 总输入 ${count(turn.inputTotalTokens ?? null)} tokens`}
              >
                {turnCache}
              </span>
            )}
            {turn.model && <span>{turn.model}</span>}
            {turn.stopReason && <span title="模型给出的停止原因">停止原因 {turn.stopReason}</span>}
            {turn.retryOf ? <span className="tag quiet">重试第 {turn.retryOf} 轮</span> : null}
            {turn.completeness === 'partial' && (
              <span className="tag warn">{incompleteLabel(turn.incompleteReason)}</span>
            )}
            {turn.completeness === 'error' && <span className="tag danger">{errorReason}</span>}
            {turn.superseded && !expanded && <span className="tag quiet">已被下一轮重试取代</span>}
            {foldable && (
              <button
                type="button"
                className="link small"
                aria-expanded={expanded}
                aria-controls={expanded ? `turn-${turn.turnIndex}-content` : undefined}
                onClick={() => setToggled(!expanded)}
              >
                {expanded ? '收起' : '展开'}
              </button>
            )}
            <button
              type="button"
              className="link raw-link"
              onClick={() => openRaw(turn.recordId, `第 ${turn.turnIndex} 轮的原始数据`)}
            >
              原始数据
            </button>
          </div>
          {expanded && (
            <div className="turn-content" id={`turn-${turn.turnIndex}-content`}>
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
                  search={search}
                />
              )}
              <MessageList messages={own} pendingId={pendingId} search={search} />
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
            <Link
              to="/"
              activeOptions={{ exact: true }}
              search={openAt(search, spur.id)}
              className="link"
            >
              会话 #{spur.id}「{spur.title || '无标题'}」
            </Link>
          </p>
        </div>
      ))}
    </>
  );
}

function InheritedTurns({
  detail,
  search,
  openRaw,
}: {
  detail: ConversationDetail;
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
          <Link
            to="/"
            activeOptions={{ exact: true }}
            search={openAt(search, source.id, source.turn)}
            className="link small"
          >
            打开会话 #{source.id}
          </Link>
        </span>
      </div>
      {open && (
        <InheritedBody id={source.id} until={source.turn} openRaw={openRaw} search={search} />
      )}
    </div>
  );
}

function InheritedBody({
  id,
  until,
  openRaw,
  search,
}: {
  id: number;
  until: number;
  openRaw: (recordId: number, title: string) => void;
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

export function ConversationHeader({
  detail,
  search,
}: {
  detail: ConversationDetail;
  search: AppSearch;
}) {
  const c = detail.conversation;
  const rate = hitRate(c.cacheReadTokens, c.inputTotalTokens);
  const totalCost = cost(c.charge, c.chargeUsd);
  return (
    <section className="reader-head">
      <Link
        to="/"
        activeOptions={{ exact: true }}
        search={validateAppSearch({ ...search, c: undefined, t: undefined, r: undefined })}
        className="link back"
      >
        <Icon name="left" size={14} /> {search.tab === 'requests' ? '请求列表' : '会话列表'}
      </Link>
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
        {totalCost ? (
          <span className="cost" title="网关计费，非上游成本">
            <b>{totalCost}</b> <span className="muted">· 网关计费，非上游成本</span>
          </span>
        ) : (
          <span className="muted">费用未知</span>
        )}
        {totalCost && c.chargePartial && <span className="muted">{partialChargeNote}</span>}
        {(c.cacheReadTokens != null || c.cacheWriteTokens != null) && (
          <span>
            缓存读取 <b>{count(c.cacheReadTokens ?? null)}</b> · 写入{' '}
            <b>{count(c.cacheWriteTokens ?? null)}</b>
            {rate && ` · 命中率 ${rate}`}
          </span>
        )}
        {c.searchCount > 0 && (
          <span title="费用合计已包含这些搜索请求">
            含联网搜索 <b>{c.searchCount.toLocaleString()}</b> 次
          </span>
        )}
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
                <Link
                  to="/"
                  activeOptions={{ exact: true }}
                  search={openAt(search, detail.subagentOf.id)}
                  className="link"
                >
                  会话 #{detail.subagentOf.id}「{detail.subagentOf.title ?? '无标题'}」
                </Link>{' '}
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
            <Link
              to="/"
              activeOptions={{ exact: true }}
              search={openAt(search, detail.forkedFrom.id)}
              className="link"
            >
              会话 #{detail.forkedFrom.id}「{detail.forkedFrom.title ?? '无标题'}」
            </Link>{' '}
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
              <Link
                to="/"
                activeOptions={{ exact: true }}
                search={openAt(search, agent.id)}
                className="link"
              >
                {agent.agentName ?? `会话 #${agent.id}`}
              </Link>
            </span>
          ))}
          {detail.subagentCount > detail.subagentsPreview.length && ' 等'}
        </p>
      )}
    </section>
  );
}

/**
 * Earlier turns [from, until) loaded above the main stream. Reads pages until a turn at or after
 * `until` appears (so the last turn here is complete) and reports when it has everything.
 */
function EarlierTurns({
  id,
  from,
  until,
  search,
  openRaw,
  spursAt,
  onDone,
}: {
  id: number;
  from: number;
  until: number;
  search: AppSearch;
  openRaw: (recordId: number, title: string) => void;
  spursAt: Map<number, { id: number; title: string }[]>;
  onDone: (from: number, done: boolean) => void;
}) {
  const { query, turns, lastSeen } = useFragments(id, from, until - 1, 'from');
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;
  const more = query.data !== undefined && lastSeen < until && hasNextPage;
  const done = query.data !== undefined && !more;
  useEffect(() => {
    if (more && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [more, isFetching, isFetchNextPageError, fetchNextPage]);
  useEffect(() => onDone(from, done), [from, done, onDone]);
  if (query.isPending) return <Loading label="正在载入前面的轮次…" />;
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      {turns.map((view, index) => (
        <TurnBlock
          key={view.turn.turnIndex}
          view={view}
          anchored={false}
          openRaw={openRaw}
          spurs={spursAt.get(view.turn.turnIndex) ?? []}
          search={search}
          streamOpen={more && index === turns.length - 1}
        />
      ))}
      {more && isFetchNextPageError && !isFetching && (
        <button type="button" className="link small load-more" onClick={() => void fetchNextPage()}>
          继续载入
        </button>
      )}
    </>
  );
}

/** Floating "回到开头" / "最新" controls; hidden ones stay visible while keyboard-focused. */
export function JumpControls({
  showTop,
  showEnd,
  toTop,
  toEnd,
}: {
  showTop: boolean;
  showEnd: boolean;
  toTop: () => void;
  toEnd: () => void;
}) {
  return (
    <div className="jump">
      <button
        type="button"
        className={`jump-button${showTop ? '' : ' away'}`}
        title="从第 1 轮开始阅读"
        onClick={toTop}
      >
        ↑ 回到开头
      </button>
      <button
        type="button"
        className={`jump-button${showEnd ? '' : ' away'}`}
        title="跳到最新一轮"
        onClick={toEnd}
      >
        ↓ 最新
      </button>
    </div>
  );
}

export function ConversationReader({ id, search }: { id: number; search: AppSearch }) {
  const detail = useQuery(conversationQuery(id));
  // The main stream starts at the anchored turn, at the latest turns, or at turn 1; `earlier`
  // lists the starts of ranges added above it, newest first.
  const [view, setView] = useState<{ start: ReadingStart; earlier: number[] }>(() => ({
    start: initialStart(search.t),
    earlier: [],
  }));
  const [done, setDone] = useState<ReadonlySet<number>>(() => new Set());
  const reset = useCallback((start: ReadingStart) => {
    setView({ start, earlier: [] });
    setDone(new Set());
  }, []);
  const [anchorT, setAnchorT] = useState(search.t);
  if (anchorT !== search.t) {
    setAnchorT(search.t);
    reset(initialStart(search.t));
  }
  const lastTurnIndex = detail.data?.lastTurnIndex ?? null;
  const main = mainStart(view.start, lastTurnIndex);
  const anchor = view.start.kind === 'anchor' ? view.start.turn : undefined;
  // A refreshed detail can move the tail start; earlier ranges were cut against the old one.
  const [mainSeen, setMainSeen] = useState(main);
  if (mainSeen !== main) {
    setMainSeen(main);
    if (view.earlier.length > 0) reset(view.start);
  }
  const { query, turns } = useFragments(
    id,
    main,
    undefined,
    anchor === undefined ? 'from' : 'at',
    // The latest turns are known only from the detail.
    view.start.kind !== 'tail' || detail.data !== undefined,
  );
  const position = useReadingPosition();
  const { toEnd, toTop, release } = position;
  // Opening at the latest turns follows the end until the reader scrolls; anchors take over.
  useEffect(() => {
    if (view.start.kind === 'tail') toEnd();
    else if (view.start.kind === 'anchor') release();
  }, [view.start, toEnd, release]);
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
    root: position.scroller,
  });
  const lowest = view.earlier.at(-1) ?? main;
  const atBeginning = lowest <= 1;
  const earlierBusy = view.earlier.length > 0 && !done.has(lowest);
  const loadEarlier = useCallback(
    () =>
      setView((current) => {
        const low = current.earlier.at(-1) ?? main;
        return low <= 1
          ? current
          : { ...current, earlier: [...current.earlier, earlierStart(low)] };
      }),
    [main],
  );
  const onDone = useCallback(
    (from: number, value: boolean) =>
      setDone((previous) => {
        if (previous.has(from) === value) return previous;
        const next = new Set(previous);
        if (value) next.add(from);
        else next.delete(from);
        return next;
      }),
    [],
  );
  // Top sentinel: reaching the top loads the previous EARLIER_STEP turns, one range at a time.
  const top = useSentinel({
    hasNextPage: query.data !== undefined && !atBeginning,
    isFetching: earlierBusy,
    failed: false,
    load: loadEarlier,
    root: position.scroller,
  });
  const jumpEnd = useCallback(() => {
    // The end is not loaded (anchored or reading from turn 1): restart at the latest turns.
    // Already reading the tail: keep earlier ranges; pinning lets the bottom sentinel finish.
    if (hasNextPage && view.start.kind !== 'tail') reset({ kind: 'tail' });
    toEnd();
  }, [hasNextPage, view.start.kind, reset, toEnd]);
  const jumpTop = useCallback(() => {
    if (!atBeginning) reset({ kind: 'top' });
    toTop();
  }, [atBeginning, reset, toTop]);
  // [ and ] jump between turns outside text inputs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== '[' && event.key !== ']') return;
      if (modalOpen()) return;
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
  // Inherited turns precede turn 1; show them only once the beginning is loaded.
  const beginningLoaded =
    atBeginning && (view.earlier.length > 0 ? done.has(lowest) : !query.isPending);
  return (
    <>
      <ConversationHeader detail={detail.data} search={search} />
      <div className="thread" ref={position.ref}>
        {!atBeginning && query.data !== undefined && (
          <div ref={top.ref} className="sentinel top-sentinel">
            {top.showManual && (
              <button type="button" className="ghost earlier" onClick={loadEarlier}>
                载入前面的轮次（从第 {earlierStart(lowest)} 轮开始）
              </button>
            )}
          </div>
        )}
        {beginningLoaded && (
          <InheritedTurns detail={detail.data} search={search} openRaw={openRaw} />
        )}
        {earlierRanges(main, view.earlier).map((range) => (
          <EarlierTurns
            key={range.from}
            id={id}
            from={range.from}
            until={range.until}
            search={search}
            openRaw={openRaw}
            spursAt={spursAt}
            onDone={onDone}
          />
        ))}
        {query.isPending ? (
          <Loading label="正在载入对话内容…" />
        ) : query.isError && !query.data ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : turns.length === 0 && view.earlier.length === 0 ? (
          <EmptyState title="这段会话没有可显示的内容" />
        ) : (
          turns.map((turnView, index) => (
            <TurnBlock
              key={turnView.turn.turnIndex}
              view={turnView}
              anchored={anchor !== undefined && anchor === turnView.turn.turnIndex}
              openRaw={openRaw}
              spurs={spursAt.get(turnView.turn.turnIndex) ?? []}
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
      <JumpControls
        showTop={!position.atTop || !atBeginning}
        showEnd={!position.atEnd}
        toTop={jumpTop}
        toEnd={jumpEnd}
      />
      {raw && <RawDrawer recordId={raw.recordId} title={raw.title} close={closeRaw} />}
    </>
  );
}

/** Where a search request stores the text it returned to the model. */
export const SEARCH_OUTPUT_PATH = ['report', 'response', 'body', 'output'];

type RequestSearch = NonNullable<RequestRow['search']>;

/**
 * Paged output text of a search request, read through the bounded record view. Shows the text only
 * when the stored output is a string; anything else stays in the raw browser.
 */
export function SearchOutput({ recordId }: { recordId: number }) {
  const [offsets, setOffsets] = useState<number[]>([0]);
  const offset = offsets.at(-1) ?? 0;
  const query = useQuery(recordViewQuery(recordId, SEARCH_OUTPUT_PATH, offset));
  if (query.isPending) return <Loading label="正在读取搜索输出…" />;
  if (query.isError || query.data.node.kind !== 'string')
    return <p className="muted small">没有记录到可读的搜索输出，可查看原始数据。</p>;
  const view = query.data;
  const next = view.nextOffset;
  return (
    <section className="search-output" aria-label="搜索输出">
      <h2 className="section-label">搜索返回给模型的文本</h2>
      <div className="text mono-block">{view.text ?? ''}</div>
      {(view.offset > 0 || next !== null) && (
        <div className="raw-pager">
          <button
            type="button"
            className="ghost"
            disabled={offsets.length < 2}
            onClick={() => setOffsets((previous) => previous.slice(0, -1))}
          >
            上一页
          </button>
          <span>
            {view.offset.toLocaleString()}–{(next ?? view.total).toLocaleString()} /{' '}
            {view.total.toLocaleString()} 字
          </span>
          <button
            type="button"
            className="ghost"
            disabled={next === null}
            onClick={() => {
              if (next !== null) setOffsets((previous) => [...previous, next]);
            }}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

/** Operations, result count and the consuming turn of one search request. */
export function SearchFacts({ info, search }: { info: RequestSearch; search: AppSearch }) {
  return (
    <section className="search-facts" aria-label="搜索操作">
      <p className="facts">
        <span>
          <b>联网搜索</b> · {info.operations.length.toLocaleString()} 项操作
        </span>
        {info.resultCount !== null && (
          <span>
            <b>{info.resultCount.toLocaleString()}</b> 条结果
          </span>
        )}
      </p>
      <SearchOperations operations={info.operations} />
      {info.linked ? (
        <p className="note">
          这次搜索的输出被{' '}
          <Link
            to="/"
            activeOptions={{ exact: true }}
            search={openAt(search, info.linked.conversationId, info.linked.turnIndex)}
            className="link"
          >
            会话 #{info.linked.conversationId} 第 {info.linked.turnIndex} 轮
          </Link>{' '}
          的工具结果使用，费用计入该会话。
        </p>
      ) : (
        <p className="note">
          没有找到唯一使用这次搜索输出的工具结果，所以没有关联到会话，费用也不计入任何会话。
        </p>
      )}
    </section>
  );
}

export function RequestReader({ recordId, search }: { recordId: number; search: AppSearch }) {
  const root = useQuery(recordViewQuery(recordId, [], 0));
  const meta = root.data?.meta;
  const request = useQuery(requestQuery(recordId));
  const row = request.data;
  const info = row?.search ?? undefined;
  const title = info ? searchOperationsSummary(info.operations) : null;
  return (
    <>
      <section className="reader-head">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          search={validateAppSearch({ ...search, r: undefined })}
          className="link back"
        >
          <Icon name="left" size={14} /> 请求列表
        </Link>
        <h1>{title ?? (meta ? meta.model || '未知模型' : '单条请求')}</h1>
        {meta && (
          <p className="facts">
            {title && <span>{meta.model || '未知模型'}</span>}
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
            {row && cost(row.charge, row.chargeUsd) && (
              <span className="cost" title="网关计费，非上游成本">
                {cost(row.charge, row.chargeUsd)}
              </span>
            )}
            {row?.completeness === 'partial' && (
              <span className="tag warn">{incompleteLabel(row.incompleteReason)}</span>
            )}
            {row?.completeness === 'error' && <span className="tag danger">报错</span>}
          </p>
        )}
        {info ? (
          <SearchFacts info={info} search={search} />
        ) : (
          row && (
            <p className="note">
              这条请求不是对话格式（例如搜索、图片或音频），不属于任何会话，只能查看原始数据。
            </p>
          )
        )}
      </section>
      <div className="thread">
        {request.isError ? (
          <ErrorState error={request.error} retry={() => void request.refetch()} />
        ) : root.isError ? (
          <ErrorState error={root.error} retry={() => void root.refetch()} />
        ) : (
          <>
            {info && <SearchOutput recordId={recordId} />}
            <h2 className="section-label">原始数据</h2>
            <RawBrowser recordId={recordId} />
          </>
        )}
      </div>
    </>
  );
}
