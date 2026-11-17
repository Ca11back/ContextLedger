import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDashboardQueryClient } from '../src/client/queries';
import type { MessageView } from '../src/client/transcript';
import { Message } from '../src/components/Message';

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
