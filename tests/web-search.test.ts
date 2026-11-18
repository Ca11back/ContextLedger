import { afterEach, expect, test } from 'bun:test';
import type { Envelope } from '../src/contracts';
import { conversationDetail, fragments, requests, turns } from '../src/server/conversation-api';
import { Ledger } from '../src/server/storage';

const stores: Ledger[] = [];
const params = new URLSearchParams();
const since = 1_795_000_000_000;
const execCall = {
  type: 'custom_tool_call',
  name: 'exec',
  call_id: 'exec-1',
  input: 'console.log(await tools.web.run({}));',
};
const directCall = {
  type: 'function_call',
  namespace: 'web',
  name: 'run',
  call_id: 'direct-1',
  arguments: '{"search_query":[]}',
};
const prompt = { role: 'user', content: 'Find synthetic references.' };
const answer = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'A synthetic answer.' }],
};
const resultText = 'Search evidence as a complete text segment.\n🧪';
const secondText = 'Another exact source, from the same execution.';
const session = 'test-session';

function fixture() {
  const store = new Ledger({
    database: ':memory:',
    source: 'synthetic',
    maxStorageBytes: 32_000_000,
    reserveBytes: 256_000,
    maxBodyBytes: 1_048_576,
    adminUser: 'admin',
    adminPassword: 'synthetic-admin-password',
    ingestToken: 'synthetic-ingest-token-12345678',
    maintenanceMs: 30000,
  });
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function response(
  input: unknown[],
  output: unknown[] = [answer],
  opts: { thread?: string; session?: string; previous?: string; responseId?: string } = {},
): Envelope {
  return {
    version: 1,
    source: 'synthetic',
    upload_id: crypto.randomUUID(),
    context: { format: 'openai_responses', model: 'test-model' },
    report: {
      requestId: crypto.randomUUID(),
      startedAt: since + 100,
      user: { id: 11 },
      token: { id: 22 },
      usage: { promptTokens: 5, completionTokens: 2, cacheTokens: 1 },
      cost: { quota: 1_000, usd: 0.002 },
      request: {
        body: {
          instructions: 'Keep synthetic references separate.',
          input,
          ...(opts.previous ? { previous_response_id: opts.previous } : {}),
          client_metadata: {
            'x-codex-turn-metadata': JSON.stringify({
              thread_id: opts.thread ?? 'test-thread',
              session_id: opts.session ?? session,
            }),
          },
        },
      },
      response: {
        status: 200,
        stream: false,
        truncated: false,
        body: { id: opts.responseId ?? crypto.randomUUID(), status: 'completed', output },
      },
    },
  };
}

function search(
  text = resultText,
  searchSession = session,
  cost: unknown = { quota: 5_000, usd: 0.01 },
): Envelope {
  const envelope = response([], []);
  envelope.context.format = 'openai_alpha_search';
  envelope.context.path = '/v1/alpha/search';
  envelope.report.startedAt = since + 50;
  envelope.report.cost = cost;
  envelope.report.usage = null;
  envelope.report.request = {
    body: {
      id: searchSession,
      commands: {
        search_query: [{ q: 'synthetic references' }],
        open: [{ ref_id: 'https://example.invalid/reference' }],
        response_length: 'short',
      },
    },
  };
  envelope.report.response = {
    status: 200,
    stream: false,
    truncated: false,
    body: { output: text, results: [{ title: 'Example' }] },
  };
  return envelope;
}
const textPart = (text: string) => ({ type: 'input_text', text });
function execResult(parts = [resultText], callId = execCall.call_id) {
  return {
    type: 'custom_tool_call_output',
    call_id: callId,
    output: [textPart('Script completed\nOutput:\n'), ...parts.map(textPart)],
  };
}
function directResult(output: unknown) {
  return { type: 'function_call_output', call_id: directCall.call_id, output };
}
function ingest(store: Ledger, envelope: Envelope) {
  return store.ingest(Buffer.from(JSON.stringify(envelope)));
}
function row(store: Ledger, recordId: number) {
  return requests(store, params).rows.find((entry) => entry.recordId === recordId)!;
}
function conversation(store: Ledger, consumerId: number) {
  return conversationDetail(store, row(store, consumerId).conversationId!).conversation;
}
function remove(store: Ledger, recordId: number) {
  store.db
    .transaction(() => (store as unknown as { deleteRoot(id: number): void }).deleteRoot(recordId))
    .immediate();
}

test('Code Mode links two exact text parts on one result, including either arrival direction', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const firstSearch = search();
  const first = await ingest(store, firstSearch);
  const consumer = await ingest(
    store,
    response([prompt, execCall, execResult([resultText, secondText])]),
  );
  const second = await ingest(store, search(secondText));
  expect(await ingest(store, firstSearch)).toEqual({ ...first, duplicate: true });

  const target = row(store, consumer.id);
  const linked = { conversationId: target.conversationId, turnIndex: target.turnIndex };
  for (const searchRow of [row(store, first.id), row(store, second.id)]) {
    expect(searchRow).toMatchObject({
      completeness: 'complete',
      conversationId: null,
      incompleteReason: null,
      search: {
        resultCount: 1,
        linked,
        operations: [
          { kind: 'search', text: 'synthetic references' },
          { kind: 'open', text: 'https://example.invalid/reference' },
        ],
      },
    });
  }
  expect(conversation(store, consumer.id)).toMatchObject({
    ownTurns: 2,
    searchCount: 2,
    charge: 12_000,
    chargePartial: false,
    inputTokens: 10,
    cacheReadTokens: 2,
  });
  expect(conversation(store, consumer.id).chargeUsd).toBeCloseTo(0.024);
  const page = fragments(
    store,
    target.conversationId!,
    new URLSearchParams({ startTurn: String(target.turnIndex) }),
  );
  const output = page.fragments.find(
    (item) => item.type === 'message' && item.kind === 'tool_result',
  );
  expect(output).toMatchObject({ searches: [{ recordId: first.id }, { recordId: second.id }] });
  expect(
    page.fragments.some((item) => item.type === 'chunk' && item.text.includes('Script completed')),
  ).toBe(true);
});

test('late ambiguity removes a link and its cost, and retention does not relink based on deletion', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const first = await ingest(store, search());
  const consumer = await ingest(store, response([prompt, execCall, execResult()]));
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 1, charge: 7_000 });
  const competitor = await ingest(store, search());
  expect(row(store, first.id).search?.linked).toBeNull();
  expect(row(store, competitor.id).search?.linked).toBeNull();
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 0, charge: 2_000 });
  remove(store, competitor.id);
  expect(row(store, first.id).search?.linked).toBeNull();
  expect(conversation(store, consumer.id).chargeUsd).toBeCloseTo(0.004);
});

test('another new consumer on the same call can make identical search evidence ambiguous', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const found = await ingest(store, search());
  const first = await ingest(store, response([prompt, execCall, execResult()]));
  expect(row(store, found.id).search?.linked?.turnIndex).toBe(row(store, first.id).turnIndex!);
  const repeat = await ingest(
    store,
    response([
      prompt,
      execCall,
      execResult(),
      { role: 'user', content: 'Different input after the same output.' },
    ]),
  );
  expect(row(store, repeat.id).conversationId).not.toBe(row(store, first.id).conversationId!);
  expect(row(store, found.id).search?.linked).toBeNull();
  expect(conversation(store, first.id)).toMatchObject({ searchCount: 0, charge: 2_000 });
  expect(conversation(store, repeat.id)).toMatchObject({ searchCount: 0, charge: 1_000 });
});

for (const endpoint of ['search', 'consumer'] as const) {
  test(`retention of the ${endpoint} removes its edge and clears unknown attached charge`, async () => {
    const store = fixture();
    const origin = await ingest(store, response([prompt], [execCall]));
    const found = await ingest(store, search(resultText, session, null));
    const consumer = await ingest(store, response([prompt, execCall, execResult()]));
    expect(conversation(store, consumer.id)).toMatchObject({
      searchCount: 1,
      charge: null,
      chargeUsd: null,
      chargePartial: true,
    });
    remove(store, endpoint === 'search' ? found.id : consumer.id);
    const retained = conversation(store, origin.id);
    expect(retained).toMatchObject({
      searchCount: 0,
      charge: endpoint === 'search' ? 2_000 : 1_000,
      chargePartial: false,
    });
    if (endpoint === 'consumer') expect(row(store, found.id).search?.linked).toBeNull();
  });
}

test('source proof and reliable new input exclude unrelated jobs and old echoes', async () => {
  const store = fixture();
  const found = await ingest(store, search());
  const invalid = { ...execCall, name: 'apply_patch' };
  await ingest(store, response([prompt], [invalid], { thread: 'other-tool' }));
  await ingest(
    store,
    response([prompt, invalid, execResult()], [answer], { thread: 'other-tool' }),
  );
  await ingest(
    store,
    response([prompt, execCall, execResult()], [answer], { thread: 'root-with-history' }),
  );
  await ingest(
    store,
    response([prompt], [execCall], { thread: 'other-session', session: 'other-session' }),
  );
  await ingest(
    store,
    response([prompt, execCall, execResult()], [answer], {
      thread: 'other-session',
      session: 'other-session',
    }),
  );
  expect(row(store, found.id).search?.linked).toBeNull();

  await ingest(store, response([prompt], [execCall]));
  await ingest(store, response([prompt, execCall, execResult([resultText.replace('\n', ' ')])]));
  expect(row(store, found.id).search?.linked).toBeNull();
  const nextInput = [prompt, execCall, execResult()];
  const owner = await ingest(store, response(nextInput));
  await ingest(
    store,
    response([...nextInput, answer, { role: 'user', content: 'A new turn echoing history.' }]),
  );
  expect(row(store, found.id).search?.linked).toMatchObject({
    conversationId: row(store, owner.id).conversationId!,
    turnIndex: row(store, owner.id).turnIndex!,
  });
});

for (const wire of ['string', 'input_text'] as const) {
  test(`direct web.run search using ${wire} in an incremental Responses request`, async () => {
    const store = fixture();
    const responseId = 'fixture-response-id';
    await ingest(store, response([prompt], [directCall], { responseId }));
    const found = await ingest(store, search());
    const result = wire === 'string' ? resultText : [textPart(resultText)];
    const used = await ingest(
      store,
      response([directResult(result)], [answer], { previous: responseId }),
    );
    expect(row(store, found.id).search?.linked).toMatchObject({
      conversationId: row(store, used.id).conversationId!,
      turnIndex: row(store, used.id).turnIndex!,
    });
    expect(turns(store, row(store, used.id).conversationId!, params).turns.at(-1)?.linkRule).toBe(
      'prev_id',
    );
  });
}

test('late conflicting source evidence revokes an incremental result and its attached charge', async () => {
  const store = fixture();
  const putAt = (value: Envelope, receivedAt: number) =>
    store.ingest(Buffer.from(JSON.stringify(value)), { receivedAt });
  await putAt(response([prompt], [execCall], { responseId: 'source-response' }), since + 10);
  const found = await putAt(search(), since + 15);
  const consumer = await putAt(
    response([execResult()], [answer], { previous: 'source-response' }),
    since + 30,
  );
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 1, charge: 7_000 });

  // Arrival is late, but the recorded source precedes the consumer. A different
  // tool with the same call id makes the source proof ambiguous.
  await putAt(response([prompt], [{ ...execCall, name: 'apply_patch' }]), since + 20);
  expect(row(store, found.id).search?.linked).toBeNull();
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 0, charge: 3_000 });
  expect(conversation(store, consumer.id).chargeUsd).toBeCloseTo(0.006);
});

test('source proof cannot cross declared threads even within one session', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall], { thread: 'source-thread' }));
  await ingest(store, response([prompt], [answer], { responseId: 'consumer-parent' }));
  const found = await ingest(store, search());
  await ingest(store, response([execResult()], [answer], { previous: 'consumer-parent' }));
  expect(row(store, found.id).search?.linked).toBeNull();
  expect(store.db.query('SELECT count(*) AS n FROM tool_output_parts').get()).toEqual({ n: 0 });
});

test('an incremental result without a captured tool call remains unproven', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [answer], { responseId: 'missing-source-parent' }));
  const found = await ingest(store, search());
  const consumer = await ingest(
    store,
    response([execResult()], [answer], { previous: 'missing-source-parent' }),
  );
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 0, charge: 2_000 });
  expect(row(store, found.id).search?.linked).toBeNull();
  expect(store.db.query('SELECT count(*) AS n FROM tool_output_parts').get()).toEqual({ n: 0 });
});

test('a thread context reset cannot treat its captured history as a new search result', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const found = await ingest(store, search());
  const consumer = await ingest(
    store,
    response([{ role: 'user', content: 'Replaced context.' }, execCall, execResult()]),
  );
  const conversationId = row(store, consumer.id).conversationId!;
  expect(turns(store, conversationId, params).turns.at(-1)?.contextReset).toBe('no_prefix');
  expect(row(store, found.id).search?.linked).toBeNull();
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 0, charge: 2_000 });
});

test('equal-input retries retain both consuming parts and make a search ambiguous', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const found = await ingest(store, search());
  const first = await ingest(store, response([prompt, execCall, execResult()]));
  expect(conversation(store, first.id)).toMatchObject({ searchCount: 1, charge: 7_000 });
  const retry = await ingest(store, response([prompt, execCall, execResult()]));
  expect(row(store, retry.id).conversationId).toBe(row(store, first.id).conversationId!);
  expect(turns(store, row(store, retry.id).conversationId!, params).turns.at(-1)).toMatchObject({
    retryOf: row(store, first.id).turnIndex!,
  });
  expect(row(store, found.id).search?.linked).toBeNull();
  expect(conversation(store, retry.id)).toMatchObject({ searchCount: 0, charge: 3_000 });
});

test('searches never link across gateway users or tokens', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const consumer = await ingest(store, response([prompt, execCall, execResult()]));
  for (const field of ['user', 'token'] as const) {
    const isolated = search();
    isolated.report[field] = { id: 999 };
    const found = await ingest(store, isolated);
    expect(row(store, found.id).search?.linked).toBeNull();
  }
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 0, charge: 2_000 });
});

test('concurrent retries of one upload attach its search charge exactly once', async () => {
  const store = fixture();
  await ingest(store, response([prompt], [execCall]));
  const consumer = await ingest(store, response([prompt, execCall, execResult()]));
  const value = search();
  const uploaded = await Promise.all([ingest(store, value), ingest(store, value)]);
  expect(uploaded[0].id).toBe(uploaded[1].id);
  expect(uploaded.filter((entry) => entry.duplicate)).toHaveLength(1);
  expect(conversation(store, consumer.id)).toMatchObject({ searchCount: 1, charge: 7_000 });
});

test('D13 item-id continuation can attach a new result beyond its partial parent', async () => {
  const store = fixture();
  const call = { ...execCall, id: 'announced-exec' };
  const source = response([prompt]);
  source.report.response = {
    status: 200,
    stream: true,
    truncated: true,
    events: [{ data: { type: 'response.output_item.added', output_index: 0, item: call } }],
  };
  const parent = await ingest(store, source);
  const found = await ingest(store, search());
  const consumer = await ingest(store, response([prompt, call, execResult()]));
  const target = row(store, consumer.id);
  expect(target.conversationId).toBe(row(store, parent.id).conversationId!);
  expect(turns(store, target.conversationId!, params).turns.at(-1)?.linkRule).toBe(
    'prefix_partial',
  );
  expect(row(store, found.id).search?.linked).toMatchObject({
    conversationId: target.conversationId!,
    turnIndex: target.turnIndex!,
  });
});

test('distinguish capture truncation, missing stream terminal, and explicit model incomplete', async () => {
  const store = fixture();
  const whole = search();
  const complete = await ingest(store, whole);
  const truncated = search('truncated');
  truncated.report.response = { status: 200, stream: false, truncated: true };
  const clipped = await ingest(store, truncated);
  const stream = response([prompt]);
  stream.report.response = {
    status: 200,
    stream: true,
    truncated: false,
    events: [{ data: { type: 'response.created' } }],
  };
  const interrupted = await ingest(store, stream);
  const incomplete = response([prompt]);
  incomplete.report.response = {
    status: 200,
    stream: true,
    truncated: false,
    events: [
      {
        data: {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          },
        },
      },
    ],
  };
  const ended = await ingest(store, incomplete);
  const error = search('error');
  error.report.response = {
    status: 200,
    stream: false,
    truncated: false,
    body: { error: { message: 'synthetic error' } },
  };
  const failed = await ingest(store, error);
  expect(row(store, complete.id)).toMatchObject({
    completeness: 'complete',
    incompleteReason: null,
  });
  expect(row(store, clipped.id)).toMatchObject({
    completeness: 'partial',
    incompleteReason: 'truncated',
  });
  expect(row(store, interrupted.id)).toMatchObject({
    completeness: 'partial',
    incompleteReason: 'no_terminal',
  });
  expect(row(store, ended.id)).toMatchObject({ completeness: 'partial', incompleteReason: null });
  expect(turns(store, row(store, ended.id).conversationId!, params).turns.at(-1)).toMatchObject({
    stopReason: 'max_output_tokens',
    incompleteReason: null,
  });
  expect(row(store, failed.id)).toMatchObject({ completeness: 'error', incompleteReason: null });
});
