/** Synthetic local-only browser data: bun run <this-file> /tmp/contextledger-demo/ledger.sqlite */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Envelope } from '../../src/contracts';
import { Ledger } from '../../src/server/storage';

const database = resolve(process.argv[2] ?? '/tmp/contextledger-conversation-demo/ledger.sqlite');
if (existsSync(database))
  throw new Error('Refusing to overwrite an existing database; choose a fresh temporary path');
mkdirSync(dirname(database), { recursive: true });
const store = new Ledger({
  database,
  maxStorageBytes: 128 * 1024 * 1024,
  reserveBytes: 256 * 1024,
  maxBodyBytes: 32 * 1024 * 1024,
  adminUser: 'demo',
  adminPassword: 'synthetic-demo-password',
  ingestToken: 'synthetic-demo-ingest-token',
  source: 'synthetic-demo',
  maintenanceMs: 30000,
});
let sequence = 0;
function env(
  input: unknown[],
  output: unknown[],
  thread?: string,
  window = 'one',
  parent?: string,
): Envelope {
  sequence++;
  return {
    version: 1,
    source: 'synthetic-demo',
    upload_id: crypto.randomUUID(),
    context: { format: 'openai_responses', model: sequence % 2 ? 'demo-model-a' : 'demo-model-b' },
    report: {
      requestId: `demo-request-${sequence}`,
      durationMs: 1250,
      user: { id: 1, username: '演示用户' },
      token: { id: 2, name: '本地演示' },
      usage: { promptTokens: 120, completionTokens: 80 },
      cost: { quota: sequence === 1 ? 0 : 20 },
      request: {
        body: {
          input,
          ...(thread
            ? {
                client_metadata: {
                  'x-codex-turn-metadata': JSON.stringify({
                    thread_id: thread,
                    session_id: 'demo-session',
                    window_id: window,
                    ...(parent
                      ? {
                          parent_thread_id: parent,
                          agent_name: '文档助手',
                          subagent_kind: 'worker',
                        }
                      : {}),
                  }),
                },
              }
            : {}),
        },
      },
      response: {
        status: 200,
        body: { id: `demo-response-${sequence}`, status: 'completed', output },
      },
    },
  };
}
const user = (content: string) => ({ role: 'user', content });
const assistant = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
async function add(e: Envelope) {
  const result = await store.ingest(Buffer.from(JSON.stringify(e)));
  return result.id;
}
const original = [
  { role: 'system', content: '以下全部是本地合成演示内容。' },
  user('帮我整理一次项目交付计划。'),
];
const reply = '先确认目标、负责人和验收条件，再安排实施与复核。';
const main = await add(env(original, [assistant(reply)], 'main'));
const history = [...original, { role: 'assistant', content: reply }];
await add(
  env(
    [...history, user('请把计划细化为三个阶段。')],
    [assistant('第一阶段：明确范围；第二阶段：实现与测试；第三阶段：验收与发布。')],
    'main',
  ),
);
await add(
  env(
    [...history, user('换一个分支：以风险为主线。')],
    [assistant('分支计划：先检查依赖，再准备验证与回滚。')],
    'main',
  ),
);
await add(
  env(
    [user('压缩后的上下文：继续完善验收清单。')],
    [assistant('上下文已变化。保留的重点是验收清单与负责人。')],
    'main',
    'two',
  ),
);
await add(
  env(
    [user('检查文档与测试是否一致。')],
    [assistant('子代理已完成合成文档检查。')],
    'child',
    'one',
    'main',
  ),
);
await add(
  env(
    [user('检查一次长工具参数。')],
    [
      {
        type: 'function_call',
        name: 'prepare_report',
        call_id: 'demo-tool-call',
        arguments: { description: '合成工具参数：😀 中文与转义\n'.repeat(7000), rows: [1, 2, 3] },
      },
    ],
    'long-tool',
  ),
);
await add(
  env(
    [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '请描述这张演示图片。' },
          { type: 'input_image', image_url: 'https://example.invalid/synthetic-only.png' },
        ],
      },
    ],
    [assistant('这里只显示媒体占位说明，不加载远程资源。')],
    'media',
  ),
);
const partial = env(
  [user('这条回复只采集到一部分。')],
  [assistant('已收到的部分内容。')],
  'partial',
);
(partial.report.response as Record<string, unknown>).truncated = true;
await add(partial);
const failed = env([user('这条请求演示错误状态。')], [assistant('错误前已恢复的内容。')], 'error');
(failed.report.response as Record<string, unknown>).status = 500;
failed.report.error = { message: 'synthetic error' };
await add(failed);
function search(output: string) {
  const entry = env([], []);
  entry.context.format = 'openai_alpha_search';
  entry.context.path = '/v1/alpha/search';
  entry.report.request = {
    body: {
      id: 'demo-session',
      commands: {
        search_query: [{ q: '合成演示文档' }],
        open: [{ ref_id: 'https://example.invalid/search-demo' }],
        response_length: 'short',
      },
    },
  };
  entry.report.response = {
    status: 200,
    stream: false,
    truncated: false,
    body: { output, results: [{ title: '合成演示文档' }] },
  };
  entry.report.usage = { promptTokens: 0, completionTokens: 0, cacheTokens: 0 };
  entry.report.cost = { quota: 5_000, usd: 0.01 };
  return entry;
}
const unlinkedSearch = await add(search('这是独立搜索的合成结果，后续请求未消费这段文本。'));
// Retry cases share a real parent, so only the edited input occupies a branch.
const retryRootInput = [user('重试演示：请先确认交付目标。')];
const retryRootReply = '交付目标已确认，可以开始实现。';
const retryRoot = await add(env(retryRootInput, [assistant(retryRootReply)], 'retry-demo'));
const retryHistory = [...retryRootInput, { role: 'assistant', content: retryRootReply }];
const retryInput = [...retryHistory, user('按相同输入执行一次实现计划。')];
const retryError = () => {
  const failed = env(retryInput, [], 'retry-demo');
  (failed.report.response as Record<string, unknown>).status = 502;
  failed.report.error = { message: 'synthetic retry failure' };
  return failed;
};
const retryFirstError = await add(retryError());
const retrySecondError = await add(retryError());
const retrySuccess = await add(
  env(
    retryInput,
    [assistant('相同输入的第三次尝试成功，前两次错误保留为已被重试的轮次。')],
    'retry-demo',
  ),
);
const retryEditedFork = await add(
  env(
    [...retryHistory, user('真实编辑：改成先写测试，再实现。')],
    [assistant('这是修改输入产生的真实分支。')],
    'retry-demo',
  ),
);

const partialRootInput = [user('无证据部分采集演示。')];
const partialRootReply = '请继续提供执行结果。';
const partialRoot = await add(
  env(partialRootInput, [assistant(partialRootReply)], 'partial-retry-demo'),
);
const partialRetryInput = [
  ...partialRootInput,
  { role: 'assistant', content: partialRootReply },
  user('使用完全相同的输入重试。'),
];
const noEvidencePartial = env(partialRetryInput, [], 'partial-retry-demo');
(noEvidencePartial.report.response as Record<string, unknown>).truncated = true;
const partialAttempt = await add(noEvidencePartial);
const partialRetrySuccess = await add(
  env(
    partialRetryInput,
    [assistant('第二次尝试成功，部分采集不再标记整个对话。')],
    'partial-retry-demo',
  ),
);

// Both tool continuations introduce no new user text. The fork uses the last
// real user text from carried history as its title instead of an empty label.
const fallbackRootInput = [user('工具历史中的标题回退演示。')];
const toolCall = {
  type: 'function_call',
  name: 'synthetic_lookup',
  call_id: 'title-demo-call',
  arguments: '{"query":"synthetic"}',
};
const fallbackRoot = await add(env(fallbackRootInput, [toolCall], 'title-fallback-demo'));
const fallbackHistory = [...fallbackRootInput, toolCall];
const fallbackContinuation = await add(
  env(
    [
      ...fallbackHistory,
      {
        type: 'function_call_output',
        call_id: 'title-demo-call',
        output: 'synthetic first result',
      },
    ],
    [assistant('第一条工具续接完成。')],
    'title-fallback-demo',
  ),
);
const fallbackBranch = await add(
  env(
    [
      ...fallbackHistory,
      {
        type: 'function_call_output',
        call_id: 'title-demo-call',
        output: 'synthetic edited result',
      },
    ],
    [assistant('工具结果发生编辑，分支标题回退到历史用户文本。')],
    'title-fallback-demo',
  ),
);

const lateFillFirst = await add(
  env(
    [{ role: 'assistant', content: '只有助手历史，尚无用户标题。' }],
    [assistant('等待真实用户文本。')],
    'title-late-fill-demo',
  ),
);
const lateFillUser = await add(
  env(
    [user('首次真实用户文本补全空标题。')],
    [assistant('标题补全一次，后续不会重命名。')],
    'title-late-fill-demo',
  ),
);
const searchInput = [user('请用联网搜索核对合成演示文档。')];
const searchCall = {
  type: 'custom_tool_call',
  name: 'exec',
  call_id: 'demo-search-exec',
  input:
    'const result = await tools.web.run({search_query: [{q: "合成演示文档"}]}); console.log(result);',
};
await add(env(searchInput, [searchCall], 'web-search-demo'));
const searchOutput = '合成搜索结果显示，交付计划分为范围确认、实施验证和发布验收三个阶段。';
const linkedSearch = await add(search(searchOutput));
const searchConsumer = await add(
  env(
    [
      ...searchInput,
      searchCall,
      {
        type: 'custom_tool_call_output',
        call_id: searchCall.call_id,
        output: [
          { type: 'input_text', text: 'Script completed\nOutput:\n' },
          { type: 'input_text', text: searchOutput },
        ],
      },
    ],
    [assistant('已核对合成演示文档，三个阶段与交付计划一致。')],
    'web-search-demo',
  ),
);
const scenarios = {
  retryRoot,
  retryFirstError,
  retrySecondError,
  retrySuccess,
  retryEditedFork,
  partialRoot,
  partialAttempt,
  partialRetrySuccess,
  fallbackRoot,
  fallbackContinuation,
  fallbackBranch,
  lateFillFirst,
  lateFillUser,
  searchConsumer,
};
const scenarioRows = Object.fromEntries(
  Object.entries(scenarios).map(([name, recordId]) => {
    const row = store.db
      .query<
        {
          conversation_id: number;
          turn_index: number;
          retry_of_turn: number | null;
          superseded: number;
          completeness: string;
        },
        [number]
      >(
        'SELECT conversation_id,turn_index,retry_of_turn,superseded,completeness FROM requests WHERE id=?',
      )
      .get(recordId)!;
    return [
      name,
      {
        recordId,
        conversationId: row.conversation_id,
        turnIndex: row.turn_index,
        retryOf: row.retry_of_turn,
        superseded: !!row.superseded,
        completeness: row.completeness,
      },
    ];
  }),
);
// A 40-turn conversation: opens at its latest turns; scrolling up loads earlier ranges.
let longHistory: unknown[] = [user('长会话第 1 轮：列出四十个合成检查项。')];
let longRecord = 0;
for (let turn = 1; turn <= 40; turn++) {
  if (turn > 1) longHistory = [...longHistory, user(`长会话第 ${turn} 轮：继续下一个检查项。`)];
  const answer = `第 ${turn} 个检查项：${'合成说明文字。'.repeat(20 + (turn % 5) * 15)}`;
  const id = await add(env(longHistory, [assistant(answer)], 'long-40'));
  if (turn === 1) longRecord = id;
  longHistory = [...longHistory, { role: 'assistant', content: answer }];
}
const longConversation = store.db
  .query<{ conversation_id: number }, [number]>('SELECT conversation_id FROM requests WHERE id=?')
  .get(longRecord)!.conversation_id;
const first = store.db
  .query<{ conversation_id: number }, [number]>('SELECT conversation_id FROM requests WHERE id=?')
  .get(main)!;
console.log(
  JSON.stringify({
    database,
    source: 'synthetic-demo',
    mainConversationId: first.conversation_id,
    mainRecordId: main,
    longConversationId: longConversation,
    records: sequence,
    scenarios: scenarioRows,
    webSearch: { linkedSearch, unlinkedSearch, searchConsumer },
    adminUser: 'demo',
    adminPassword: 'synthetic-demo-password',
    ingestToken: 'synthetic-demo-ingest-token',
  }),
);
store.close();
