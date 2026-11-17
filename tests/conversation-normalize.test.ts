import { expect, test } from 'bun:test';
import type { Envelope } from '../src/contracts';
import { canonicalJson, normalizeEnvelope } from '../src/server/normalize';

function envelope(format: string, body: unknown, response: Record<string, unknown> = {}): Envelope {
  return {
    version: 1,
    source: 'synthetic',
    upload_id: 'synthetic',
    context: { format },
    report: {
      user: { id: 1 },
      token: { id: 2 },
      request: { body },
      response: { status: 200, ...response },
    },
  };
}
const event = (
  type: string,
  fields: object = {},
): { event: string; data: Record<string, unknown> } => ({ event: type, data: { type, ...fields } });
const normalize = (format: string, body: unknown, response: Record<string, unknown> = {}) =>
  normalizeEnvelope(envelope(format, body, response));
const responseMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  id: 'output-id',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const responseFinal = (output: unknown[]) => ({
  body: { id: 'resp', status: 'completed', output },
});
const user = { role: 'user', content: 'question' };

test('Responses known output shells normalize to client history without stripping nested payload keys', () => {
  const output = responseMessage('answer');
  const parent = normalize(
    'openai_responses',
    { instructions: 'system', input: [user] },
    responseFinal([output]),
  );
  const child = normalize('openai_responses', {
    instructions: 'system',
    input: [
      user,
      {
        ...output,
        id: 'different',
        metadata: { label: 'display' },
        content: [{ type: 'input_text', text: 'answer' }],
      },
      { role: 'user', content: 'next' },
    ],
  });
  expect(parent.completeness).toBe('complete');
  expect(parent.evidenceChain).toBe(child.inputPrefixes[parent.evidenceCount - 1]);
  const tool = {
    type: 'function_call',
    name: 'fn',
    call_id: 'call',
    arguments: { id: 'user-id', status: 'user-status', metadata: { nested: true } },
  };
  const one = normalize('openai_responses', { input: [user] }, responseFinal([tool]));
  const two = normalize(
    'openai_responses',
    { input: [user] },
    responseFinal([{ ...tool, arguments: { ...tool.arguments, status: 'changed' } }]),
  );
  expect(one.output[0]!.parts[0]!.kind).toBe('json');
  expect(one.output[0]!.parts[0]!.text).toContain('"status": "user-status"');
  expect(one.output[0]!.itemHash).not.toBe(two.output[0]!.itemHash);
});

test('Responses uses response.completed once and ignores duplicate done items and deltas', () => {
  const output = responseMessage('complete');
  const result = normalize(
    'openai_responses',
    { input: [user] },
    {
      stream: true,
      events: [
        event('response.output_text.delta', { delta: 'complete' }),
        event('response.output_item.done', { output_index: 0, item: output }),
        event('response.completed', {
          response: { id: 'resp-final', status: 'completed', output: [output] },
        }),
      ],
    },
  );
  expect(result.output).toHaveLength(1);
  expect(result.output[0]!.parts[0]!.text).toBe('complete');
  expect(result.responseId).toBe('resp-final');
  expect(result.completeness).toBe('complete');
});

test('Responses recovers only done items in source order; deltas alone never supply coverage', () => {
  const result = normalize(
    'openai_responses',
    { input: [user] },
    {
      events: [
        event('response.output_item.done', {
          output_index: 1,
          item: {
            type: 'function_call',
            name: 'f',
            call_id: 'c',
            arguments: '{}',
            status: 'completed',
          },
        }),
        event('response.output_text.delta', { delta: 'uncompleted text' }),
        event('response.output_item.done', { output_index: 0, item: responseMessage('first') }),
      ],
    },
  );
  expect(result.completeness).toBe('partial');
  expect(result.output.map((m) => m.kind)).toEqual(['assistant', 'tool_call']);
  expect(result.evidence).toHaveLength(2);
  expect(result.evidenceChain).not.toBeNull();
  const onlyDelta = normalize(
    'openai_responses',
    { input: [user] },
    { events: [event('response.output_text.delta', { delta: 'hello' })] },
  );
  expect(onlyDelta.output).toHaveLength(0);
  expect(onlyDelta.evidenceChain).toBeNull();
});

test('unknown, context and empty reasoning cannot supply partial evidence', () => {
  const result = normalize(
    'openai_responses',
    { input: [user] },
    {
      events: [
        event('response.output_item.done', {
          item: { type: 'future_item', id: 'retain', payload: 'value' },
        }),
        event('response.output_item.done', {
          item: { type: 'compaction', encrypted_content: 'hidden' },
        }),
        event('response.output_item.done', {
          item: { type: 'reasoning', summary: [], encrypted_content: 'hidden' },
        }),
      ],
    },
  );
  expect(result.output.map((m) => m.kind)).toEqual(['other', 'context', 'reasoning']);
  expect(result.evidence).toHaveLength(0);
  expect(result.evidenceChain).toBeNull();
});

test('previous_response_id mode exposes whole input but no cumulative identity chain', () => {
  const result = normalize(
    'openai_responses',
    { input: [user], previous_response_id: 'prev' },
    responseFinal([responseMessage('answer')]),
  );
  expect(result.previousResponseId).toBe('prev');
  expect(result.inputChain).toBeNull();
  expect(result.evidenceChain).toBeNull();
  expect(result.inputPrefixes).toHaveLength(1);
});

test('full uncapped labels feed identity while descriptors are bounded and surrogate safe', () => {
  const name = `${'n'.repeat(127)}😀tail`;
  const one = normalize(
    'openai_responses',
    { input: [user] },
    responseFinal([{ type: 'function_call', name, call_id: 'c'.repeat(200), arguments: '{}' }]),
  );
  const two = normalize(
    'openai_responses',
    { input: [user] },
    responseFinal([
      { type: 'function_call', name: `${name}other`, call_id: 'c'.repeat(200), arguments: '{}' },
    ]),
  );
  expect(one.output[0]!.name).toHaveLength(127);
  expect(one.output[0]!.callId).toHaveLength(128);
  expect(one.output[0]!.itemHash).not.toBe(two.output[0]!.itemHash);
});

test('structured results are canonical JSON with payload id/status/prototype keys preserved', () => {
  const payload = JSON.parse('{"z":2,"__proto__":{"id":"payload"},"status":"ok","a":[{"id":1}]}');
  const result = normalize('openai_responses', {
    input: [{ type: 'function_call_output', call_id: 'c', output: payload }],
  });
  expect(result.input[0]!.parts).toEqual([{ kind: 'json', text: canonicalJson(payload) }]);
  expect(JSON.parse(result.input[0]!.parts[0]!.text)).toEqual(payload);
  expect(Object.hasOwn(payload, '__proto__')).toBe(true);
});

const chatEvents = () => [
  {
    data: {
      id: 'chat-id',
      choices: [
        { index: 1, delta: { content: 'alternative' }, finish_reason: 'stop' },
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: 'hello ',
            tool_calls: [
              { index: 0, id: 'a', type: 'function', function: { name: 'fi', arguments: '{"x":' } },
              {
                index: 1,
                id: 'b',
                type: 'function',
                function: { name: 'second', arguments: '{"y":' },
              },
            ],
          },
        },
      ],
    },
  },
  {
    data: {
      choices: [
        {
          index: 0,
          delta: {
            content: 'world',
            refusal: 'no',
            tool_calls: [
              { index: 1, function: { arguments: '2}' } },
              { index: 0, function: { name: 'rst', arguments: '1}' } },
            ],
          },
        },
      ],
    },
  },
  { data: { choices: [{ index: 0, delta: { refusal: 'pe' }, finish_reason: 'tool_calls' }] } },
  { data: { choices: [], usage: { total_tokens: 20 } } },
];
test('Chat stitches independent choices and parallel tool calls; trailing usage preserves primary', () => {
  const result = normalize('openai', { messages: [user] }, { stream: true, events: chatEvents() });
  expect(result.completeness).toBe('complete');
  expect(result.output.map((m) => m.kind)).toEqual([
    'assistant',
    'refusal',
    'tool_call',
    'tool_call',
  ]);
  expect(result.output[0]!.parts[0]!.text).toBe('hello world');
  expect(result.output[0]!.alternatives).toBe(1);
  expect(result.output[1]!.parts[0]!.text).toBe('nope');
  expect(result.output.slice(2).map((m) => [m.name, m.callId, m.parts[0]!.text])).toEqual([
    ['first', 'a', '{"x":1}'],
    ['second', 'b', '{"y":2}'],
  ]);
  expect(result.responseId).toBe('chat-id');
});

test('one finished alternative cannot complete Chat primary; truncation overrides finish reason', () => {
  const events = chatEvents();
  const unfinished = normalize('openai', { messages: [user] }, { events: events.slice(0, 2) });
  expect(unfinished.completeness).toBe('partial');
  expect(unfinished.evidence).toHaveLength(0);
  const truncated = normalize('openai', { messages: [user] }, { truncated: true, events });
  expect(truncated.completeness).toBe('partial');
  expect(truncated.output[0]!.parts[0]!.text).toBe('hello world');
});

test('Chat non-stream tool-call identity matches the same client assistant history', () => {
  const assistant = {
    role: 'assistant',
    content: 'answer',
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'tool', arguments: '{"id":7}' } }],
  };
  const parent = normalize(
    'openai',
    { messages: [user] },
    { body: { choices: [{ message: assistant, finish_reason: 'tool_calls' }] } },
  );
  const child = normalize('openai', {
    messages: [user, assistant, { role: 'tool', tool_call_id: 'c', content: 'result' }],
  });
  expect(parent.evidenceChain).toBe(child.inputPrefixes[parent.evidenceCount - 1]);
  expect(child.leadingHistoryCount).toBe(3);
});

const claudeEvents = () => [
  event('message_start', { message: { id: 'claude-id', content: [] } }),
  event('content_block_start', {
    index: 0,
    content_block: { type: 'thinking', thinking: 'initial ', signature: 's' },
  }),
  event('content_block_delta', {
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'thought' },
  }),
  event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'ig' } }),
  event('content_block_stop', { index: 0 }),
  event('content_block_start', { index: 1, content_block: { type: 'text', text: 'initial ' } }),
  event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer' } }),
  event('content_block_stop', { index: 1 }),
  event('content_block_start', {
    index: 2,
    content_block: { type: 'tool_use', id: 'tool-id', name: 'tool', input: {} },
  }),
  event('content_block_delta', {
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"id":"user",' },
  }),
  event('content_block_delta', {
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '"status":"ok"}' },
  }),
  event('content_block_stop', { index: 2 }),
  event('message_delta', { delta: { stop_reason: 'tool_use' } }),
  event('message_stop'),
];
test('Claude retains initial block, thinking/signature and completed structured tool input', () => {
  const result = normalize(
    'claude',
    { system: 'system', messages: [user] },
    { events: claudeEvents() },
  );
  expect(result.completeness).toBe('complete');
  expect(result.output.map((m) => m.kind)).toEqual(['reasoning', 'assistant', 'tool_call']);
  expect(result.output[0]!.parts[0]!.text).toBe('initial thought');
  expect(result.output[1]!.parts[0]!.text).toBe('initial answer');
  expect(result.output[2]!.parts[0]!.kind).toBe('json');
  expect(JSON.parse(result.output[2]!.parts[0]!.text)).toEqual({ id: 'user', status: 'ok' });
  const changed = claudeEvents();
  changed[3] = event('content_block_delta', {
    index: 0,
    delta: { type: 'signature_delta', signature: 'other' },
  });
  expect(normalize('claude', {}, { events: changed }).output[0]!.itemHash).not.toBe(
    result.output[0]!.itemHash,
  );
});

test('Claude invalid JSON stays unparsed and partial even after terminal; completed text remains evidence', () => {
  const events = claudeEvents();
  events[10] = event('content_block_delta', {
    index: 2,
    delta: { type: 'input_json_delta', partial_json: 'broken' },
  });
  const result = normalize('claude', { messages: [user] }, { events });
  expect(result.completeness).toBe('partial');
  expect(result.output[2]!.parts[0]!.text).toContain('broken');
  expect(result.output[2]!.parts[0]!.kind).toBe('text');
  expect(result.evidence.map((m) => m.kind)).toEqual(['assistant']);
});

test('Claude missing block stops cannot be trusted; whole unknown/server result/redacted blocks stay readable', () => {
  const events = claudeEvents().filter(
    (e) => !(e.event === 'content_block_stop' && e.data.index === 1),
  );
  expect(normalize('claude', {}, { events }).completeness).toBe('partial');
  const result = normalize(
    'claude',
    {},
    {
      body: {
        stop_reason: 'end_turn',
        content: [
          { type: 'future_block', id: 'user-provided', value: 'kept' },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'server-tool',
            content: [{ type: 'web_search_result', title: 'result' }],
          },
          { type: 'redacted_thinking', data: 'opaque' },
        ],
      },
    },
  );
  expect(result.output.map((m) => m.kind)).toEqual(['other', 'tool_result', 'reasoning']);
  expect(result.output[0]!.parts[0]!.text).toContain('user-provided');
  expect(result.output[1]!.callId).toBe('server-tool');
  expect(result.evidenceChain).toBeNull();
});

const geminiEvents = () => [
  {
    data: {
      responseId: 'gemini-id',
      candidates: [
        { index: 1, content: { parts: [{ text: 'alternative' }] }, finishReason: 'STOP' },
        { index: 0, content: { parts: [{ text: 'think ', thought: true }] } },
      ],
    },
  },
  {
    data: {
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'more', thought: true, thoughtSignature: 'sig' }, { text: 'answer ' }],
          },
        },
      ],
    },
  },
  {
    data: {
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              { text: 'now' },
              { functionCall: { id: 'a', name: 'first', args: { id: 1 } } },
              { functionCall: { id: 'b', name: 'second', args: { status: 2 } } },
            ],
          },
          finishReason: 'MAX_TOKENS',
        },
      ],
    },
  },
];
test('Gemini separates candidates, thought/answer and function-call boundaries with signatures', () => {
  const result = normalize(
    'gemini',
    { contents: [{ role: 'user', parts: [{ text: 'question' }] }] },
    { events: geminiEvents() },
  );
  expect(result.completeness).toBe('complete');
  expect(result.stopReason).toBe('MAX_TOKENS');
  expect(result.output.map((m) => m.kind)).toEqual([
    'reasoning',
    'assistant',
    'tool_call',
    'tool_call',
  ]);
  expect(result.output[0]!.parts[0]!.text).toBe('think more');
  expect(result.output[1]!.parts[0]!.text).toBe('answer now');
  expect(result.output[0]!.alternatives).toBe(1);
  expect(result.output.slice(2).map((m) => m.name)).toEqual(['first', 'second']);
  expect(result.output[2]!.parts[0]!.kind).toBe('json');
  const child = normalize('gemini', {
    contents: [
      { role: 'user', parts: [{ text: 'question' }] },
      {
        role: 'model',
        parts: [
          { text: 'think more', thought: true, thoughtSignature: 'sig' },
          { text: 'answer now' },
          { functionCall: { id: 'a', name: 'first', args: { id: 1 } } },
          { functionCall: { id: 'b', name: 'second', args: { status: 2 } } },
        ],
      },
    ],
  });
  expect(result.evidenceChain).toBe(child.inputPrefixes[result.evidenceCount - 1]);
});

test('Gemini keeps distinct signed text parts in the identity projection', () => {
  const parts = [
    { text: 'first', thoughtSignature: 'first-signature' },
    { text: 'second', thoughtSignature: 'second-signature' },
  ];
  const result = normalize(
    'gemini',
    {},
    {
      body: { candidates: [{ content: { parts }, finishReason: 'STOP' }] },
    },
  );
  const changed = normalize(
    'gemini',
    {},
    {
      body: {
        candidates: [
          {
            content: { parts: [{ ...parts[0], thoughtSignature: 'changed' }, parts[1]] },
            finishReason: 'STOP',
          },
        ],
      },
    },
  );
  expect(result.output.map((m) => m.parts[0]!.text)).toEqual(['first', 'second']);
  expect(result.output[0]!.itemHash).not.toBe(changed.output[0]!.itemHash);
  const streamed = normalize(
    'gemini',
    {},
    {
      events: parts.map((part, index) => ({
        data: {
          candidates: [
            {
              index: 0,
              content: { parts: [part] },
              ...(index === 1 ? { finishReason: 'STOP' } : {}),
            },
          ],
        },
      })),
    },
  );
  expect(streamed.output.map((m) => m.itemHash)).toEqual(result.output.map((m) => m.itemHash));
});

test('Gemini unfinished primary and unknown shapes do not supply evidence', () => {
  const unfinished = normalize('gemini', {}, { events: geminiEvents().slice(0, 2) });
  expect(unfinished.completeness).toBe('partial');
  expect(unfinished.evidence).toHaveLength(0);
  const result = normalize(
    'gemini',
    { contents: [{ role: 'user', parts: [{ text: 'question' }] }] },
    {
      body: {
        candidates: [{ content: { parts: [{ unknown: { id: 'kept' } }] }, finishReason: 'SAFETY' }],
      },
    },
  );
  expect(result.output[0]!.kind).toBe('other');
  expect(result.evidenceChain).toBeNull();
  expect(normalize('gemini', {}, { events: geminiEvents(), truncated: true }).completeness).toBe(
    'partial',
  );
});

for (const format of ['openai', 'openai_responses', 'claude', 'gemini']) {
  test(`${format} error event under HTTP 200 wins and preserves recovered output`, () => {
    const events =
      format === 'openai'
        ? chatEvents()
        : format === 'claude'
          ? claudeEvents()
          : format === 'gemini'
            ? geminiEvents()
            : [event('response.output_item.done', { item: responseMessage('kept') })];
    const result = normalize(
      format,
      {},
      { events: [...events, event('error', { error: { message: 'failure' } })] },
    );
    expect(result.completeness).toBe('error');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.evidenceChain).toBeNull();
  });
}

test('HTTP/report errors override trusted final body; missing terminal is always partial', () => {
  const raw = envelope(
    'openai_responses',
    { input: [user] },
    { ...responseFinal([responseMessage('kept')]), status: 429 },
  );
  expect(normalizeEnvelope(raw).completeness).toBe('error');
  raw.report.response = { ...responseFinal([responseMessage('kept')]), status: 200 };
  raw.report.error = { message: 'failed' };
  expect(normalizeEnvelope(raw).completeness).toBe('error');
  expect(normalize('openai_responses', { input: [user] }, { truncated: false }).completeness).toBe(
    'partial',
  );
});

test('normalization never mutates original report and unsupported formats remain unlinked', () => {
  const raw = envelope('openai', { messages: [user] }, { events: chatEvents() });
  const before = JSON.stringify(raw);
  normalizeEnvelope(raw);
  expect(JSON.stringify(raw)).toBe(before);
  for (const format of [
    'openai_alpha_search',
    'embedding',
    'openai_responses_compaction',
    'image',
  ]) {
    const result = normalize(format, { input: [user] }, responseFinal([responseMessage('reply')]));
    expect(result.chat).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.evidenceChain).toBeNull();
  }
});

test('root boundary and title select last user; ambiguous inputs stay in their turn', () => {
  const result = normalize('openai_responses', {
    input: [
      { role: 'user', content: 'old' },
      responseMessage('old answer'),
      { role: 'user', content: 'new title' },
    ],
  });
  expect(result.leadingHistoryCount).toBe(2);
  expect(result.title).toBe('new title');
  expect(
    normalize('openai_responses', { input: [{ type: 'reasoning', summary: [] }] })
      .leadingHistoryCount,
  ).toBe(0);
});

test('embedded media gets bounded placeholder labels and unknown-only content supplies no evidence', () => {
  for (const format of ['openai', 'openai_responses']) {
    const imageUser = {
      role: 'user',
      content: [
        { type: 'input_text', text: 'question' },
        { type: 'input_image', image_url: 'masked' },
      ],
    };
    const result = normalize(
      format,
      format === 'openai' ? { messages: [imageUser] } : { input: [imageUser] },
    );
    expect(result.media).toBe(true);
    expect(result.input[0]!.media?.label).toBe('图片');
  }
  const result = normalize(
    'openai_responses',
    { input: [user] },
    {
      events: [
        event('response.output_item.done', {
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'future_part', text: 'unknown' }],
          },
        }),
      ],
    },
  );
  expect(result.evidenceChain).toBeNull();
  expect(result.output[0]!.parts[0]!.kind).toBe('json');
});

test('known media has ordered text placeholders while complete media identity and captured input stay intact', () => {
  const url = 'https://example.invalid/image?<unsafe>';
  for (const format of ['openai', 'openai_responses']) {
    const content: Record<string, unknown>[] = [
      { type: 'input_text', text: 'before' },
      { type: 'input_image', image_url: url, detail: 'high' },
      { type: 'text', text: 'after' },
    ];
    const item = { role: 'user', content };
    const body = format === 'openai' ? { messages: [item] } : { input: [item] };
    const captured = JSON.stringify(body);
    const result = normalize(format, body);
    expect(result.input[0]!.media).toEqual({ label: '图片' });
    expect(result.input[0]!.parts).toEqual(
      ['before', '[图片]', url, 'after'].map((text) => ({ kind: 'text', text })),
    );
    expect(JSON.stringify(body)).toBe(captured);
    content[1] = { ...content[1], detail: 'low' };
    expect(normalize(format, body).input[0]!.itemHash).not.toBe(result.input[0]!.itemHash);
  }
  const cases = [
    ['openai_responses', { input: [{ type: 'input_image', image_url: url }] }],
    [
      'claude',
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url } }] }] },
    ],
    [
      'gemini',
      {
        contents: [
          { role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: url } }] },
        ],
      },
    ],
  ] as const;
  for (const [format, body] of cases) {
    const result = normalize(format, body);
    expect(result.input[0]!.kind).toBe('media');
    expect(result.input[0]!.media).toEqual({ label: '图片' });
    expect(result.input[0]!.parts).toEqual([
      { kind: 'text', text: '[图片]' },
      { kind: 'text', text: url },
    ]);
  }
  const inline = normalize('claude', {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: 'unrendered-bytes' } }],
      },
    ],
  });
  expect(inline.input[0]!.parts).toEqual([{ kind: 'text', text: '[图片]' }]);
  const unknown = normalize('openai_responses', {
    input: [{ type: 'future_media', image_url: url }],
  });
  expect(unknown.input[0]!.kind).toBe('other');
  expect(unknown.input[0]!.parts[0]!.kind).toBe('json');
});

test('Responses incomplete body does not hide recovered completed events', () => {
  const result = normalize(
    'openai_responses',
    { input: [user] },
    {
      body: { status: 'in_progress', output: [] },
      events: [event('response.output_item.done', { item: responseMessage('recovered') })],
    },
  );
  expect(result.completeness).toBe('partial');
  expect(result.output[0]!.parts[0]!.text).toBe('recovered');
});

test('legacy and modern Chat tool fields can coexist without altering captured objects', () => {
  const raw = envelope(
    'openai',
    {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [],
          function_call: { name: 'legacy', arguments: '{}' },
        },
      ],
    },
    {
      events: [
        {
          data: {
            choices: [
              {
                delta: { tool_calls: [], function_call: { name: 'legacy', arguments: '{}' } },
                finish_reason: 'tool_calls',
              },
            ],
          },
        },
      ],
    },
  );
  const before = JSON.stringify(raw);
  normalizeEnvelope(raw);
  expect(JSON.stringify(raw)).toBe(before);
});

// Build native source messages so generated media display text cannot accidentally
// satisfy the title assertions. Each protocol includes its real tool-result shape.
const userTextFormats = [
  {
    format: 'openai',
    body: (messages: unknown[]) => ({ messages }),
    user: (texts: string[], media = false) => ({
      role: 'user',
      content: [
        ...(media
          ? [{ type: 'image_url', image_url: { url: 'https://example.invalid/generated-image' } }]
          : []),
        ...texts.map((text) => ({ type: 'text', text })),
      ],
    }),
    unknown: { role: 'user', content: [{ type: 'future_part', text: 'unknown JSON preview' }] },
    tail: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c', content: 'tool result must not become a title' },
    ],
  },
  {
    format: 'openai_responses',
    body: (input: unknown[]) => ({ input }),
    user: (texts: string[], media = false) => ({
      role: 'user',
      content: [
        ...(media
          ? [{ type: 'input_image', image_url: 'https://example.invalid/generated-image' }]
          : []),
        ...texts.map((text) => ({ type: 'input_text', text })),
      ],
    }),
    unknown: { type: 'future_item', role: 'user', text: 'unknown JSON preview' },
    tail: [
      { type: 'function_call', call_id: 'c', name: 'tool', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'c',
        output: { text: 'tool result must not become a title' },
      },
    ],
  },
  {
    format: 'claude',
    body: (messages: unknown[]) => ({ messages }),
    user: (texts: string[], media = false) => ({
      role: 'user',
      content: [
        ...(media
          ? [
              {
                type: 'image',
                source: { type: 'url', url: 'https://example.invalid/generated-image' },
              },
            ]
          : []),
        ...texts.map((text) => ({ type: 'text', text })),
      ],
    }),
    unknown: { role: 'user', content: [{ type: 'future_block', text: 'unknown JSON preview' }] },
    tail: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'tool', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c', content: 'tool result must not become a title' },
        ],
      },
    ],
  },
  {
    format: 'gemini',
    body: (contents: unknown[]) => ({ contents }),
    user: (texts: string[], media = false) => ({
      role: 'user',
      parts: [
        ...(media
          ? [
              {
                fileData: {
                  mimeType: 'image/png',
                  fileUri: 'https://example.invalid/generated-image',
                },
              },
            ]
          : []),
        ...texts.map((text) => ({ text })),
      ],
    }),
    unknown: {
      role: 'user',
      parts: [{ text: 'unknown JSON preview', future_field: 'not known text' }],
    },
    tail: [
      { role: 'model', parts: [{ functionCall: { id: 'c', name: 'tool', args: {} } }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'c',
              name: 'tool',
              response: { text: 'tool result must not become a title' },
            },
          },
        ],
      },
    ],
  },
];

for (const fixture of userTextFormats) {
  test(`${fixture.format} title metadata excludes media placeholders, tool results and unknown previews`, () => {
    const body = fixture.body([fixture.user([], true), ...fixture.tail, fixture.unknown]);
    const before = JSON.stringify(body);
    const result = normalize(fixture.format, body);
    expect(result.lastUserText).toBe('');
    expect(result.title).toBe('');
    expect(result.input.every((m) => m.userText === '')).toBe(true);
    expect(result.input.some((m) => m.parts.some((p) => p.text === '[图片]'))).toBe(true);
    expect(JSON.stringify(body)).toBe(before);
  });

  test(`${fixture.format} last real user text includes leading history before trailing tool results`, () => {
    const result = normalize(
      fixture.format,
      fixture.body([
        fixture.user(['old real user text']),
        fixture.user(['latest real user text'], true),
        ...fixture.tail,
      ]),
    );
    expect(result.leadingHistoryCount).toBeGreaterThan(0);
    expect(result.input.slice(result.leadingHistoryCount).every((m) => m.userText === '')).toBe(
      true,
    );
    expect(result.lastUserText).toBe('latest real user text');
    expect(result.title).toBe('latest real user text');
  });

  test(`${fixture.format} genuine placeholder and literal URL text remain user text`, () => {
    const literal = '[图片] https://example.invalid/user-typed';
    const result = normalize(fixture.format, fixture.body([fixture.user([literal], true)]));
    expect(result.lastUserText).toBe(literal);
    expect(result.title).toBe(literal);
    expect(result.input.find((m) => m.userText)?.userText).toBe(literal);
  });

  test(`${fixture.format} title text is bounded surrogate-safe and later real text fills an empty input`, () => {
    const empty = normalize(fixture.format, fixture.body([fixture.user(['', '  '], true)]));
    expect(empty.lastUserText).toBe('');
    expect(empty.title).toBe('');
    const text = `${'字'.repeat(119)}😀tail`;
    const later = normalize(
      fixture.format,
      fixture.body([fixture.user(['', '  '], true), fixture.user([text], true), ...fixture.tail]),
    );
    expect(later.lastUserText).toBe('字'.repeat(119));
    expect(later.title).toBe('字'.repeat(119));
    expect(later.input.every((m) => m.userText.length <= 120)).toBe(true);
    const fits = normalize(
      fixture.format,
      fixture.body([fixture.user([`${'a'.repeat(118)}😀tail`])]),
    );
    expect(fits.lastUserText).toBe(`${'a'.repeat(118)}😀`);
    expect(fits.lastUserText).toHaveLength(120);
  });

  test(`${fixture.format} mixed source text selects actual text while display ordering stays intact`, () => {
    const result = normalize(
      fixture.format,
      fixture.body([fixture.user(['first actual', 'second actual'], true)]),
    );
    const summary = result.lastUserText;
    expect(summary).toContain('first actual');
    expect(summary).toContain('second actual');
    expect(summary).not.toContain('[图片]');
    expect(summary).not.toContain('https://example.invalid/generated-image');
    expect(result.input.filter((m) => m.kind === 'user').every((m) => m.userText === summary)).toBe(
      true,
    );
  });
}

test('previous-response retries retain a full input fingerprint without introducing prefix chains', () => {
  const plain = normalize('openai_responses', { instructions: 'system', input: [user] });
  const one = normalize('openai_responses', {
    instructions: 'system',
    input: [user],
    previous_response_id: 'previous',
  });
  const same = normalize(
    'openai_responses',
    { instructions: 'system', input: [user], previous_response_id: 'previous' },
    responseFinal([responseMessage('different reply')]),
  );
  const edited = normalize('openai_responses', {
    instructions: 'system',
    input: [{ ...user, content: 'edited' }],
    previous_response_id: 'previous',
  });
  expect(one.retryInputChain).toHaveLength(64);
  expect(one.retryInputChain).toBe(same.retryInputChain);
  expect(one.retryInputChain).toBe(plain.inputChain!);
  expect(one.input.map((m) => m.itemHash)).toEqual(plain.input.map((m) => m.itemHash));
  expect(one.inputPrefixes).toEqual(plain.inputPrefixes);
  expect(one.retryInputChain).not.toBe(edited.retryInputChain);
  expect(one.inputChain).toBeNull();
  expect(one.evidenceChain).toBeNull();
  const empty = normalize('openai_responses', { input: [], previous_response_id: 'previous' });
  expect(empty.retryInputChain).toHaveLength(64);
  expect(empty.retryInputChain).toBe(normalize('openai_responses', { input: [] }).retryInputChain);
  expect(empty.retryInputChain).not.toBe(one.retryInputChain);
});
