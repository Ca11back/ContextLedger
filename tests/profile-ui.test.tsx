import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { cacheHit, charge, cost, hitRate, usd } from '../src/client/format';
import { conversationsQuery, createDashboardQueryClient } from '../src/client/queries';
import type { AppSearch } from '../src/client/search';
import type { MessageView } from '../src/client/transcript';
import { CaughtError } from '../src/components/Feedback';
import { ConversationList } from '../src/components/Lists';
import { Message } from '../src/components/Message';
import { RawDrawer } from '../src/components/RawDrawer';
import { ConversationHeader, TurnBlock } from '../src/components/Reader';
import type { ConversationRow, TurnSummary } from '../src/conversation-contracts';
import { WithRouter } from './support/router';

function render(message: MessageView) {
  const client = createDashboardQueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Message message={message} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const base = {
  messageId: 'm',
  turnIndex: 1,
  side: 'input' as const,
  partCount: 1,
};

test('messages render report content as escaped text, never markup or remote media', () => {
  const html = render({
    ...base,
    kind: 'user',
    parts: [
      {
        partIndex: 0,
        partKind: 'text',
        partTotal: 60,
        text: '<script>alert(1)</script><img src="https://private.example/x">',
        continuation: null,
      },
    ],
  });
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('href=');
});

test('tool results are folded to three lines and masked media is a label only', () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
  const tool = render({
    ...base,
    kind: 'tool_result',
    name: '<b>shell</b>',
    parts: [
      { partIndex: 0, partKind: 'text', partTotal: lines.length, text: lines, continuation: null },
    ],
  });
  expect(tool).toContain('line 2');
  expect(tool).not.toContain('line 3');
  expect(tool).toContain('共 10 行');
  expect(tool).toContain('&lt;b&gt;shell&lt;/b&gt;');
  const media = render({
    ...base,
    kind: 'media',
    partCount: 0,
    media: { label: 'image/png · <img src=x>' },
    parts: [],
  });
  expect(media).toContain('已由网关遮罩');
  expect(media).toContain('&lt;img src=x&gt;');
  expect(media).not.toContain('<img');
});

test('a long part offers continuation with loaded and total size', () => {
  const html = render({
    ...base,
    kind: 'assistant',
    parts: [
      {
        partIndex: 0,
        partKind: 'text',
        partTotal: 20000,
        text: 'a'.repeat(8192),
        continuation: 'next',
      },
    ],
  });
  expect(html).toContain('继续载入（已显示 8,192 / 20,000 字）');
});

test('superseded attempts are dimmed with a retry note and retries are labelled', () => {
  const turn = (turnIndex: number, extra: Partial<TurnSummary>): TurnSummary => ({
    turnIndex,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
    recordId: turnIndex,
    requestId: `req-${turnIndex}`,
    receivedAt: 0,
    model: 'm',
    inputTokens: null,
    outputTokens: null,
    charge: null,
    durationMs: null,
    completeness: 'complete',
    linkRule: 'prefix',
    parentOutputIncomplete: false,
    contextReset: null,
    media: false,
    ...extra,
  });
  // Anchored, so the folded attempts start expanded and show their notes.
  const renderTurn = (summary: TurnSummary) => {
    const client = createDashboardQueryClient();
    try {
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <TurnBlock
            view={{ turn: summary, reset: null, messages: [] }}
            anchored
            openRaw={() => {}}
            spurs={[]}
            search={{}}
          />
        </QueryClientProvider>,
      );
    } finally {
      client.clear();
    }
  };
  const failed = renderTurn(turn(1, { completeness: 'error', superseded: true }));
  expect(failed).toContain('anchored superseded');
  expect(failed).toContain('这次请求失败，');
  expect(failed).toContain('客户端在后面用同样的内容重试了');
  expect(failed).not.toContain('这次请求报错，没有收到回复内容');
  const complete = renderTurn(turn(2, { superseded: true }));
  expect(complete).not.toContain('没有完整采集');
  expect(complete).toContain('客户端在后面用同样的内容重试了');
  const retry = renderTurn(turn(3, { retryOf: 1 }));
  expect(retry).toContain('重试第 1 轮');
  expect(retry).not.toContain('superseded');
});

test('a message header whose content never arrived says so once the stream has ended', () => {
  const header = { ...base, kind: 'assistant' as const, partCount: 1, parts: [] };
  const ended = render(header);
  expect(ended).toContain('这段内容没有返回，可查看原始数据');
  expect(ended).not.toContain('正在载入…');
  const client = createDashboardQueryClient();
  try {
    const pending = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Message message={header} pending />
      </QueryClientProvider>,
    );
    expect(pending).toContain('正在载入…');
    expect(pending).not.toContain('这段内容没有返回');
  } finally {
    client.clear();
  }
});

test('only the last message of an open stream is still loading', () => {
  const summary: TurnSummary = {
    turnIndex: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
    recordId: 1,
    requestId: 'req-1',
    receivedAt: 0,
    model: 'm',
    inputTokens: null,
    outputTokens: null,
    charge: null,
    durationMs: null,
    completeness: 'complete',
    linkRule: null,
    parentOutputIncomplete: false,
    contextReset: null,
    media: false,
  };
  const messages: MessageView[] = [
    { ...base, messageId: 'a', kind: 'user', parts: [] },
    { ...base, messageId: 'b', kind: 'assistant', side: 'output', parts: [] },
  ];
  const renderTurn = (streamOpen: boolean) => {
    const client = createDashboardQueryClient();
    try {
      return renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <TurnBlock
            view={{ turn: summary, reset: null, messages }}
            anchored={false}
            openRaw={() => {}}
            spurs={[]}
            search={{}}
            streamOpen={streamOpen}
          />
        </QueryClientProvider>,
      );
    } finally {
      client.clear();
    }
  };
  const open = renderTurn(true);
  expect(open.split('这段内容没有返回').length - 1).toBe(1);
  expect(open.split('正在载入…').length - 1).toBe(1);
  const ended = renderTurn(false);
  expect(ended.split('这段内容没有返回').length - 1).toBe(2);
  expect(ended).not.toContain('正在载入…');
});

function summaryOf(extra: Partial<TurnSummary>): TurnSummary {
  return {
    turnIndex: 6,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
    recordId: 24,
    requestId: 'req-6',
    receivedAt: 0,
    model: 'm',
    inputTokens: 26,
    outputTokens: 10,
    charge: null,
    durationMs: null,
    completeness: 'complete',
    linkRule: 'prefix',
    parentOutputIncomplete: false,
    contextReset: null,
    media: false,
    ...extra,
  };
}

function renderTurnView(summary: TurnSummary, messages: MessageView[], anchored = false) {
  const client = createDashboardQueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WithRouter>
          <TurnBlock
            view={{ turn: summary, reset: null, messages }}
            anchored={anchored}
            openRaw={() => {}}
            spurs={[{ id: 9, title: 'branch' }]}
            search={{ user: 'alice' }}
          />
        </WithRouter>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const reply: MessageView = {
  ...base,
  messageId: 'reply',
  kind: 'assistant',
  side: 'output',
  parts: [
    { partIndex: 0, partKind: 'text', partTotal: 14, text: 'partial answer', continuation: null },
  ],
};

test('error turns are one line by default and open expanded when anchored', () => {
  const summary = summaryOf({ completeness: 'error', durationMs: 901_600 });
  const folded = renderTurnView(summary, [reply]);
  expect(folded).toContain('turn collapsed');
  expect(folded).toContain('报错（15 分钟后中断）');
  expect(folded).toContain('aria-expanded="false"');
  expect(folded).toContain('>展开<');
  expect(folded).toContain('原始数据');
  expect(folded).not.toContain('partial answer');
  expect(folded).toContain('会话 #9');
  const anchored = renderTurnView(summary, [reply], true);
  expect(anchored).not.toContain('collapsed');
  expect(anchored).toContain('partial answer');
  expect(anchored).toContain('>收起<');
  const quick = renderTurnView(summaryOf({ completeness: 'error', durationMs: 3_000 }), []);
  expect(quick).toContain('报错（请求失败）');
});

test('superseded turns are folded to their head', () => {
  const html = renderTurnView(summaryOf({ superseded: true }), [reply]);
  expect(html).toContain('turn superseded collapsed');
  expect(html).toContain('已被下一轮重试取代');
  expect(html).not.toContain('partial answer');
  expect(html).not.toContain('客户端在后面用同样的内容重试了');
  const complete = renderTurnView(summaryOf({}), [reply]);
  expect(complete).not.toContain('collapsed');
  expect(complete).not.toContain('aria-expanded');
  expect(complete).toContain('partial answer');
});

test('consecutive empty reasoning merges into one line; reasoning with text is unchanged', () => {
  const empty = (index: number): MessageView => ({
    ...base,
    messageId: `r${index}`,
    kind: 'reasoning',
    side: 'output',
    partCount: index % 2 ? 0 : 1,
    parts:
      index % 2
        ? []
        : [{ partIndex: 0, partKind: 'text', partTotal: 2, text: ' \n', continuation: null }],
  });
  const runs = Array.from({ length: 16 }, (_, index) => empty(index));
  const thought: MessageView = {
    ...base,
    messageId: 'thought',
    kind: 'reasoning',
    side: 'output',
    parts: [
      { partIndex: 0, partKind: 'text', partTotal: 12, text: 'Check config', continuation: null },
    ],
  };
  const html = renderTurnView(summaryOf({}), [...runs, thought, empty(99), reply]);
  expect(html.split('模型思考了').length - 1).toBe(2);
  expect(html).toContain('模型思考了 16 步（内容已加密，未记录）');
  expect(html).toContain('模型思考了 1 步（内容已加密，未记录）');
  expect(html).toContain('Check config');
  expect(html.split('思考摘要').length - 1).toBe(1);
  expect(html).toContain('partial answer');
});

test('a pending reasoning message is not counted as empty', () => {
  const pending: MessageView = {
    ...base,
    messageId: 'last',
    kind: 'reasoning',
    side: 'output',
    parts: [],
  };
  const client = createDashboardQueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TurnBlock
          view={{ turn: summaryOf({}), reset: null, messages: [pending] }}
          anchored={false}
          openRaw={() => {}}
          spurs={[]}
          search={{}}
          streamOpen
        />
      </QueryClientProvider>,
    );
    expect(html).not.toContain('模型思考了');
    expect(html).toContain('正在载入…');
  } finally {
    client.clear();
  }
});

test('caught render errors show the error state with a retry', () => {
  const html = renderToStaticMarkup(
    <CaughtError title="阅读区出错了" error={new Error('<b>boom</b>')} reset={() => {}} />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('阅读区出错了');
  expect(html).toContain('&lt;b&gt;boom&lt;/b&gt;');
  expect(html).toContain('重试');
  expect(renderToStaticMarkup(<CaughtError error="plain" reset={() => {}} />)).toContain('plain');
});

test('raw drawer is a native dialog without hand-rolled modal semantics', () => {
  const client = createDashboardQueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RawDrawer recordId={1} title="第 1 轮的原始数据" close={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toStartWith('<dialog');
    expect(html).toContain('closedby="any"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1">第 1 轮的原始数据<\/h2>/);
    // showModal() supplies these; the server markup must not be open or claim them itself.
    expect(html).not.toMatch(/<dialog[^>]* open/);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  } finally {
    client.clear();
  }
});

test('collapsed turns only point aria-controls at content that exists', () => {
  const summary = summaryOf({ completeness: 'error' });
  const folded = renderTurnView(summary, [reply]);
  expect(folded).toContain('aria-expanded="false"');
  expect(folded).not.toContain('aria-controls');
  const open = renderTurnView(summary, [reply], true);
  expect(open).toContain('aria-controls="turn-6-content"');
  expect(open).toContain('id="turn-6-content"');
});

test('fork spurs are links that keep the current filters', () => {
  const html = renderTurnView(summaryOf({}), [reply]);
  expect(html).toContain('<a class="link" href="/?c=9&amp;user=alice">');
});

test('cost and cache formatting never shows unknown values as zero', () => {
  expect(usd(0.12)).toBe('$0.12');
  expect(usd(0.5)).toBe('$0.50');
  expect(usd(0.000123)).toBe('$0.00012');
  expect(usd(1234.5)).toBe('$1,234.50');
  expect(usd(0)).toBe('$0.00');
  expect(usd(null)).toBe('费用未知');
  expect(usd(undefined)).toBe('费用未知');
  expect(charge(30000)).toBe('30,000 quota');
  expect(charge(null)).toBe('费用未知');
  // Known totals are complete: never qualified with "至少".
  expect(cost(12000, 0.024)).toBe('$0.024 · 12,000 quota');
  expect(cost(12000, null)).toBe('12,000 quota');
  expect(cost(null, 0.5)).toBe('$0.50');
  expect(cost(0, 0)).toBe('$0.00 · 0 quota');
  expect(cost(null, undefined)).toBeNull();
  expect(cacheHit(142000, 149000)).toBe('缓存命中 142,000（95%）');
  expect(cacheHit(0, 1000)).toBe('缓存命中 0（0%）');
  expect(cacheHit(1, 1000)).toBe('缓存命中 1（<1%）');
  expect(cacheHit(5, null)).toBe('缓存命中 5');
  expect(cacheHit(5, 0)).toBe('缓存命中 5');
  expect(cacheHit(null, 1000)).toBeNull();
  expect(cacheHit(undefined, undefined)).toBeNull();
  expect(hitRate(null, 10)).toBeNull();
});

test('turn heads show cost and cache only when known', () => {
  const known = renderTurnView(
    summaryOf({
      charge: 12000,
      chargeUsd: 0.024,
      cacheReadTokens: 142000,
      inputTotalTokens: 149000,
    }),
    [reply],
  );
  // Both units are visible text, not only a tooltip.
  expect(known).toContain('>$0.024 · 12,000 quota</span>');
  const quotaOnly = renderTurnView(summaryOf({ charge: 500, chargeUsd: null }), [reply]);
  expect(quotaOnly).toContain('>500 quota</span>');
  expect(quotaOnly).not.toContain('$');
  const usdOnly = renderTurnView(summaryOf({ charge: null, chargeUsd: 0.5 }), [reply]);
  expect(usdOnly).toContain('>$0.50</span>');
  expect(usdOnly).not.toContain('quota');
  expect(known).toContain('缓存命中 142,000（95%）');
  const unknown = renderTurnView(
    summaryOf({ charge: null, chargeUsd: null, cacheReadTokens: null, inputTotalTokens: null }),
    [reply],
  );
  expect(unknown).not.toContain('$');
  expect(unknown).not.toContain('缓存命中');
  expect(unknown).not.toContain('quota');
  // Defaults: every statistic unknown.
  const legacy = renderTurnView(summaryOf({}), [reply]);
  expect(legacy).not.toContain('缓存命中');
});

function rowOf(conversation: Partial<ConversationRow>): ConversationRow {
  return {
    id: 3,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTotalTokens: null,
    chargeUsd: null,
    title: 't',
    user: 'u',
    token: 'k',
    models: ['m'],
    moreModels: false,
    ownTurns: 2,
    inheritedTurns: 0,
    firstAt: 0,
    lastAt: 0,
    inputTokens: 10,
    outputTokens: 5,
    charge: null,
    chargePartial: false,
    hasError: false,
    hasPartial: false,
    forkedFrom: null,
    branchCount: 0,
    subagentOf: null,
    agentName: null,
    subagentKind: null,
    subagentCount: 0,
    ...conversation,
  };
}

function renderHeader(conversation: Partial<ConversationRow>) {
  const row = rowOf(conversation);
  return renderToStaticMarkup(
    <WithRouter>
      <ConversationHeader
        detail={{
          conversation: row,
          forkedFrom: null,
          branchesPreview: [],
          branchCount: 0,
          subagentOf: null,
          subagentsPreview: [],
          subagentCount: 0,
        }}
        search={{ c: 3 }}
      />
    </WithRouter>,
  );
}

test('conversation header totals cost, quota and cache with the gateway note', () => {
  const html = renderHeader({
    charge: 30000,
    chargeUsd: 0.06,
    chargePartial: true,
    cacheReadTokens: 900,
    cacheWriteTokens: 100,
    inputTotalTokens: 1000,
  });
  expect(html).toContain('<b>$0.060 · 30,000 quota</b>');
  expect(html).not.toContain('至少');
  expect(html).toContain('<span class="muted">部分轮次费用未知</span>');
  expect(html).toContain('缓存读取 <b>900</b> · 写入 <b>100</b> · 命中率 90%');
  expect(html).toContain('网关计费，非上游成本');
  const complete = renderHeader({ charge: 30000, chargeUsd: 0.06 });
  expect(complete).not.toContain('部分轮次费用未知');
  // Only quota is complete (USD missing on some turn): show quota plus the partial note.
  const quotaOnly = renderHeader({ charge: 30000, chargeUsd: null, chargePartial: true });
  expect(quotaOnly).toContain('<b>30,000 quota</b>');
  expect(quotaOnly).not.toContain('$');
  expect(quotaOnly).toContain('部分轮次费用未知');
  const unknown = renderHeader({ chargePartial: true });
  // Neither unit known: a muted "费用未知" instead of nothing, without a redundant partial note.
  expect(unknown).toContain('<span class="muted">费用未知</span>');
  expect(unknown).not.toContain('部分轮次费用未知');
  expect(unknown).not.toContain('quota');
  expect(unknown).not.toContain('网关计费');
  expect(unknown).not.toContain('$');
  expect(unknown).not.toContain('缓存读取');
  const noTotal = renderHeader({ cacheReadTokens: 0, cacheWriteTokens: null, inputTotalTokens: 0 });
  expect(noTotal).toContain('缓存读取 <b>0</b> · 写入 <b>未知</b>');
  expect(noTotal).not.toContain('命中率');
});

function renderConversationList(search: AppSearch, rows: ConversationRow[]) {
  const client = createDashboardQueryClient();
  client.setQueryData(conversationsQuery(search).queryKey, {
    pages: [{ rows, cursor: null }],
    pageParams: [null],
  });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WithRouter>
          <ConversationList search={search} go={() => {}} />
        </WithRouter>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

test('conversation list rows show both cost units and the sort toggle follows the URL', () => {
  const rows = [
    rowOf({ id: 1, charge: 12000, chargeUsd: 0.024 }),
    rowOf({ id: 2, charge: 500, chargeUsd: null, chargePartial: true }),
    rowOf({ id: 3 }),
  ];
  const recent = renderConversationList({}, rows);
  expect(recent).toContain('aria-pressed="true">最近</button>');
  expect(recent).toContain('aria-pressed="false">费用</button>');
  expect(recent).toContain('title="网关计费，非上游成本">$0.024 · 12,000 quota</span>');
  expect(recent).toContain('title="网关计费，非上游成本；部分轮次费用未知">500 quota</span>');
  expect(recent).not.toContain('至少');
  expect(recent.match(/class="cost"/g)?.length).toBe(2);
  const byCost = renderConversationList({ sort: 'cost' }, rows);
  expect(byCost).toContain('aria-pressed="false">最近</button>');
  expect(byCost).toContain('aria-pressed="true">费用</button>');
});
