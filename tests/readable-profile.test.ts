import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('../plugins/ca11back_contextledger/plugin.js', import.meta.url),
  'utf8',
).replaceAll('export ', '');
interface Normalized {
  report: any;
  capture: any;
}
const normalize = (record: any, format = 'openai_responses'): Normalized =>
  runInNewContext(source + '\nnormalizeReport(ctx, record);', {
    ctx: { format },
    record,
    TextEncoder,
  });
const event = (type: string, fields: object = {}, extra: object = {}) => ({
  event: type,
  data: { type, ...fields },
  ...extra,
});
function fixture() {
  const output = [
    {
      id: 'msg1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello 中文 😀', annotations: [] }],
    },
    {
      id: 'fn1',
      type: 'function_call',
      name: 'function_tool',
      call_id: 'call1',
      status: 'completed',
      arguments: '{"a":1}',
    },
    {
      id: 'custom1',
      type: 'custom_tool_call',
      name: 'shell',
      call_id: 'call2',
      status: 'completed',
      input: 'ls -la\n中文',
    },
    {
      id: 'reason1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Readable summary' }],
      encrypted_content: 'opaque-output',
    },
  ];
  const effective = {
    tools: [{ type: 'custom', name: 'shell', format: { type: 'text' } }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    instructions: null,
    temperature: 0.7,
  };
  const final = {
    id: 'resp1',
    object: 'response',
    status: 'completed',
    ...effective,
    output,
    usage: { input_tokens: 12, output_tokens: 10 },
    error: null,
    incomplete_details: null,
    future_final: 'preserved',
  };
  const events = [
    event('response.created', {
      response: {
        id: 'resp1',
        object: 'response',
        status: 'in_progress',
        ...effective,
        output: [],
        error: null,
      },
    }),
    event('response.in_progress', {
      response: { id: 'resp1', status: 'in_progress', ...effective, output: [] },
    }),
    event('response.output_item.added', {
      output_index: 0,
      item: { id: 'msg1', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    }),
    event('response.content_part.added', {
      output_index: 0,
      item_id: 'msg1',
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
    event('response.output_text.delta', {
      output_index: 0,
      item_id: 'msg1',
      content_index: 0,
      delta: 'Hello ',
    }),
    event('response.output_text.delta', {
      output_index: 0,
      item_id: 'msg1',
      content_index: 0,
      delta: '中文 😀',
    }),
    event('response.output_text.done', {
      output_index: 0,
      item_id: 'msg1',
      content_index: 0,
      text: 'Hello 中文 😀',
    }),
    event('response.content_part.done', {
      output_index: 0,
      item_id: 'msg1',
      content_index: 0,
      part: output[0]!.content![0],
    }),
    event('response.output_item.done', { output_index: 0, item: output[0] }),
    event('response.output_item.added', {
      output_index: 1,
      item: {
        id: 'fn1',
        type: 'function_call',
        status: 'in_progress',
        name: 'function_tool',
        call_id: 'call1',
        arguments: '',
      },
    }),
    event('response.function_call_arguments.delta', {
      output_index: 1,
      item_id: 'fn1',
      delta: '{"a":',
    }),
    event('response.function_call_arguments.delta', {
      output_index: 1,
      item_id: 'fn1',
      delta: '1}',
    }),
    event('response.function_call_arguments.done', {
      output_index: 1,
      item_id: 'fn1',
      arguments: '{"a":1}',
    }),
    event('response.output_item.done', { output_index: 1, item: output[1] }),
    event('response.output_item.added', {
      output_index: 2,
      item: {
        id: 'custom1',
        type: 'custom_tool_call',
        status: 'in_progress',
        name: 'shell',
        call_id: 'call2',
        input: '',
      },
    }),
    event('response.custom_tool_call_input.delta', {
      output_index: 2,
      item_id: 'custom1',
      delta: 'ls -la\n',
    }),
    event('response.custom_tool_call_input.delta', {
      output_index: 2,
      item_id: 'custom1',
      delta: '中文',
    }),
    event('response.custom_tool_call_input.done', {
      output_index: 2,
      item_id: 'custom1',
      input: 'ls -la\n中文',
    }),
    event('response.output_item.done', { output_index: 2, item: output[2] }),
    event('response.reasoning_summary_text.delta', {
      output_index: 3,
      item_id: 'reason1',
      summary_index: 0,
      delta: 'Readable summary',
    }),
    event('response.reasoning_summary_text.done', {
      output_index: 3,
      item_id: 'reason1',
      summary_index: 0,
      text: 'Readable summary',
    }),
    event('response.output_item.done', { output_index: 3, item: output[3] }),
    event('response.completed', { response: final }),
  ];
  return {
    request: {
      body: {
        model: 'synthetic',
        input: [
          {
            type: 'reasoning',
            encrypted_content: 'opaque-input',
            summary: [{ type: 'summary_text', text: 'Prior summary' }],
          },
        ],
      },
    },
    response: { status: 200, stream: true, truncated: false, events },
    usage: { promptTokens: 12 },
    cost: { usd: 0.1 },
  };
}
test('complete Responses retains effective response-only tools and all text/custom/function/summary content', () => {
  const input = fixture(),
    original = JSON.stringify(input),
    result = normalize(input);
  expect(JSON.stringify(input)).toBe(original);
  expect(result.capture.response.mode).toBe('final_snapshot');
  expect(result.report.response.events).toEqual([]);
  const final = result.report.response.body;
  expect(final.output[0].content[0].text).toBe('Hello 中文 😀');
  expect(final.output[1].arguments).toBe('{"a":1}');
  expect(final.output[2].input).toBe('ls -la\n中文');
  expect(final.output[3].summary[0].text).toBe('Readable summary');
  expect(final.tools[0].name).toBe('shell');
  expect(final.temperature).toBe(0.7);
  expect(final.future_final).toBe('preserved');
  expect(result.report.usage).toEqual(input.usage);
  expect(result.report.cost).toEqual(input.cost);
  expect(result.report.request.body.tools).toBeUndefined();
  expect(result.capture.response.omitted_events).toBe(input.response.events.length);
  expect(result.capture.response.retained_events).toBe(0);
  expect(result.capture.original_report_bytes).toBe(Buffer.byteLength(original));
});
test('structured encryption stripping is recursive, counts encoded value bytes, leaves ordinary strings unchanged', () => {
  const ordinary = '{"encrypted_content":"ordinary tool argument"}';
  const record = {
    request: {
      body: {
        nested: [
          { encrypted_content: '密😀\n', text: ordinary },
          { encrypted_content: null },
          { encrypted_content: { nested: 'cipher', encrypted_content: 'nested-value' } },
        ],
        encrypted_content: 'root',
      },
    },
    response: { body: { encrypted_content: 'answer', summary: 'readable' }, stream: false },
  };
  const input = JSON.stringify(record),
    result = normalize(record);
  expect(result.capture.encrypted_content.removed_fields).toBe(5);
  expect(result.capture.encrypted_content.removed_value_json_bytes).toBe(
    [
      '密😀\n',
      null,
      { nested: 'cipher', encrypted_content: 'nested-value' },
      'root',
      'answer',
    ].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0),
  );
  expect(result.capture.original_report_bytes).toBe(Buffer.byteLength(input));
  expect(result.report.request.body.nested[0].text).toBe(ordinary);
  expect(result.report.response.body.summary).toBe('readable');
  expect(JSON.stringify(record)).toBe(input);
  expect(result.report.request.body.nested[2]).toEqual({});
});
test('omitted event byte metadata counts post-strip serialized elements without commas', () => {
  const record = fixture(),
    stripped = normalize(record, 'openai').report;
  const result = normalize(record);
  expect(result.capture.response.omitted_event_json_bytes).toBe(
    stripped.response.events.reduce(
      (n: number, e: unknown) => n + Buffer.byteLength(JSON.stringify(e)),
      0,
    ),
  );
});
test('unknown events and auxiliary wrapper/data fields remain inspectable', () => {
  const record = fixture();
  record.response.events.splice(1, 0, event('response.future', { future: { text: 'unknown' } }));
  const withAux = event('response.output_text.done', {
    output_index: 0,
    item_id: 'msg1',
    content_index: 0,
    text: 'Hello 中文 😀',
    future_aux: 'keep',
  });
  record.response.events.splice(2, 0, withAux);
  const wrapper = event(
    'response.created',
    { response: { id: 'resp1', status: 'in_progress' } },
    { timestamp: 123 },
  );
  record.response.events.splice(3, 0, wrapper);
  const result = normalize(record);
  expect(result.capture.response.mode).toBe('final_snapshot');
  expect(result.report.response.events).toEqual([record.response.events[1]]);
  expect(
    result.capture.lifecycle_residue.some(
      (entry: any) => entry.position === 'data.future_aux' && entry.value === 'keep',
    ),
  ).toBe(true);
  expect(
    result.capture.lifecycle_residue.some(
      (entry: any) => entry.position === 'event.timestamp' && entry.value === 123,
    ),
  ).toBe(true);
});
test('changed response echoes are retained when absent from final effective snapshot', () => {
  const record = fixture();
  (record.response.events[0]!.data as any).response.tools = [
    { type: 'custom', name: 'old-effective-tool' },
  ];
  (record.response.events[1]!.data as any).response.unique_aux = 'only-early';
  const result = normalize(record);
  expect(result.capture.response.mode).toBe('final_snapshot');
  expect(result.report.response.events.length).toBe(0);
  expect(
    result.capture.lifecycle_residue.some(
      (entry: any) =>
        entry.position === 'data.response.tools' && entry.value[0].name === 'old-effective-tool',
    ),
  ).toBe(true);
  expect(
    result.capture.lifecycle_residue.some(
      (entry: any) => entry.position === 'data.response.unique_aux' && entry.value === 'only-early',
    ),
  ).toBe(true);
});
const fallbackCases: [string, (record: any) => void][] = [
  ['missing final', (r) => r.response.events.pop()],
  ['missing output', (r) => delete r.response.events.at(-1).data.response.output],
  ['empty final with visible deltas', (r) => (r.response.events.at(-1).data.response.output = [])],
  [
    'custom input mismatch',
    (r) => (r.response.events.at(-1).data.response.output[2].input = 'lost'),
  ],
  [
    'function args mismatch',
    (r) => (r.response.events.at(-1).data.response.output[1].arguments = '{}'),
  ],
  [
    'text mismatch',
    (r) => (r.response.events.at(-1).data.response.output[0].content[0].text = 'lost'),
  ],
  ['reported truncation', (r) => (r.response.truncated = true)],
  ['unknown truncation', (r) => delete r.response.truncated],
  ['error', (r) => (r.error = { message: 'failure' })],
  ['HTTP error', (r) => (r.response.status = 500)],
  ['incomplete terminal', (r) => (r.response.events.at(-1).data.response.status = 'incomplete')],
  [
    'incomplete output item',
    (r) => (r.response.events.at(-1).data.response.output[0].status = 'in_progress'),
  ],
  ['multiple completed', (r) => r.response.events.push(r.response.events.at(-1))],
  [
    'interrupted event',
    (r) =>
      r.response.events.splice(2, 0, event('response.failed', { error: { message: 'failed' } })),
  ],
  ['unknown delta position', (r) => (r.response.events[4].data.output_index = 999)],
  ['item id mismatch', (r) => (r.response.events[4].data.item_id = 'other')],
  [
    'events after final',
    (r) =>
      r.response.events.push(
        event('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'later' }),
      ),
  ],
  ['existing body differs', (r) => (r.response.body = { output: [] })],
];
for (const [name, change] of fallbackCases)
  test('fallback preserves all events: ' + name, () => {
    // Deep copy prevents shared fixture references from changing both final and done values.
    const record = JSON.parse(JSON.stringify(fixture()));
    change(record);
    const original = JSON.stringify(record);
    const result = normalize(record),
      stripped = normalize(record, 'openai');
    expect(result.capture.response.mode).toBe('events_retained');
    expect(result.capture.response.omitted_events).toBe(0);
    expect(result.report.response.events).toEqual(stripped.report.response.events);
    expect(JSON.stringify(record)).toBe(original);
  });
test('unknown protocols and missing-output usage-only terminal never fabricate complete responses', () => {
  for (const format of ['openai', 'claude', 'gemini', 'future']) {
    const record = fixture(),
      result = normalize(record, format);
    expect(result.capture.response.reason).toBe('unsupported_protocol');
    expect(result.report.response.body).toBeUndefined();
    expect(result.report.response.events.length).toBe(record.response.events.length);
  }
  const record = {
    response: {
      status: 200,
      stream: true,
      truncated: false,
      events: [
        event('response.output_text.delta', {
          output_index: 0,
          content_index: 0,
          delta: 'only readable text',
        }),
        event('response.completed', {
          response: { status: 'completed', usage: { output_tokens: 4 } },
        }),
      ],
    },
  };
  expect(normalize(record).capture.response.reason).toBe('incomplete_final');
});
test('per-call work budget fails with a static code before fetch and does not mutate input', () => {
  const record: any = {};
  let current = record;
  for (let i = 0; i < 100; i++) current = current.next = {};
  expect(() => normalize(record)).toThrow('contextledger_profile_budget');
  const original = JSON.stringify(record);
  expect(() => normalize(record)).toThrow();
  expect(JSON.stringify(record)).toBe(original);
});
test('terminal auxiliarymetadata uses residue, finalpayload appears exactly once', () => {
  const record = fixture();
  (record.response.events.at(-1)!.data as any).unknown_terminal = { state: 'new' };
  (record.response.events.at(-1) as any).timestamp = 77;
  const result = normalize(record);
  expect(result.capture.response.mode).toBe('final_snapshot');
  expect(result.report.response.events.length).toBe(0);
  expect(
    result.capture.lifecycle_residue.some((r: any) => r.position === 'data.unknown_terminal'),
  ).toBe(true);
  expect(JSON.stringify(result).split('future_final').length - 1).toBe(1);
});
test('unknown contentbearing delta fallsback; arbitrary nested lifecycle-named fields are retained', () => {
  const record = fixture();
  record.response.events.splice(
    0,
    0,
    event('response.future_content.delta', { delta: 'unknown-visible' }),
  );
  expect(normalize(record).capture.response.reason).toBe('unknown_content_delta');
  const r = fixture();
  (r.response.events[0]!.data as any).response.future = {
    status: 'in_progress',
    usage: null,
    obfuscation: 'user-data',
  };
  (r.response.events.at(-1)!.data as any).response.future = {
    status: 'completed',
    usage: 20,
    obfuscation: 'new',
  };
  const result = normalize(r);
  expect(
    result.capture.lifecycle_residue.some(
      (entry: any) =>
        entry.position === 'data.response.future' && entry.value.obfuscation === 'user-data',
    ),
  ).toBe(true);
});
test('prototype-like own JSON keys survive pureclone and residue without affecting prototypes', () => {
  const record = JSON.parse(
    '{"request":{"body":{"__proto__":{"text":"keep"},"constructor":"ctor","prototype":"proto","encrypted_content":"drop"}},"response":{"stream":false,"body":{"text":"safe"}}}',
  );
  const result = normalize(record);
  expect(Object.hasOwn(result.report.request.body, '__proto__')).toBe(true);
  expect(result.report.request.body.__proto__.text).toBe('keep');
  expect(result.report.request.body.constructor).toBe('ctor');
  expect(result.report.request.body.prototype).toBe('proto');
  expect(({} as any).text).toBeUndefined();
});
test('done-only visible text or tools cannot disagree with finalsnapshot', () => {
  const r = JSON.parse(JSON.stringify(fixture()));
  r.response.events = r.response.events.filter(
    (e: any) =>
      !e.data.type.endsWith('.delta') &&
      !e.data.type.endsWith('_text.done') &&
      !e.data.type.endsWith('_arguments.done') &&
      !e.data.type.endsWith('_input.done'),
  );
  r.response.events.find(
    (e: any) => e.data.type === 'response.output_item.done',
  ).data.item.content[0].text = 'mismatching visible text';
  expect(normalize(r).capture.response.mode).toBe('events_retained');
});
