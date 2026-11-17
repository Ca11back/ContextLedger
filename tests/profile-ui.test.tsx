import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDashboardQueryClient } from '../src/client/queries';
import type { MessageView } from '../src/client/transcript';
import { Message } from '../src/components/Message';
import { TurnBlock } from '../src/components/Reader';
import type { TurnSummary } from '../src/conversation-contracts';

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
            go={() => {}}
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
            go={() => {}}
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
        <TurnBlock
          view={{ turn: summary, reset: null, messages }}
          anchored={anchored}
          openRaw={() => {}}
          spurs={[{ id: 9, title: 'branch' }]}
          go={() => {}}
          search={{}}
        />
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
          go={() => {}}
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
