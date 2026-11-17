/** Synthetic browser fixture only. bun run <this-file> /tmp/<fresh>/ledger.sqlite */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Envelope } from '../../src/contracts';
import { fragments } from '../../src/server/conversation-api';
import { Ledger } from '../../src/server/storage';
import { partialLoopFixtures } from './partial-fixtures';

const database = resolve(process.argv[2] ?? '/tmp/contextledger-partial-demo/ledger.sqlite');
if (existsSync(database)) throw new Error('fresh_demo_database_required');
mkdirSync(dirname(database), { recursive: true });
const store = new Ledger({
  database,
  maxStorageBytes: 128 * 1024 * 1024,
  reserveBytes: 256 * 1024,
  maxBodyBytes: 32 * 1024 * 1024,
  adminUser: 'demo',
  adminPassword: 'synthetic-demo-password',
  ingestToken: 'synthetic-demo-ingest-token',
  source: 'synthetic',
  maintenanceMs: 30000,
});
try {
  store.db.query('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('requests', 40);
  for (const env of partialLoopFixtures()) await store.ingest(Buffer.from(JSON.stringify(env)));
  const scroll: Envelope = {
    version: 1,
    source: 'synthetic',
    upload_id: crypto.randomUUID(),
    context: { format: 'openai_responses', model: 'synthetic-scroll-model' },
    report: {
      requestId: 'synthetic-scroll-request',
      user: { id: 1, username: 'synthetic-user' },
      token: { id: 2, name: 'synthetic-token' },
      usage: { promptTokens: 100, completionTokens: 120 },
      cost: { quota: 0 },
      request: {
        body: {
          input: [{ role: 'user', content: 'Synthetic second-page scrolling verification' }],
          client_metadata: {
            'x-codex-turn-metadata': JSON.stringify({
              thread_id: 'synthetic-scroll-thread',
              session_id: 'synthetic-session',
            }),
          },
        },
      },
      response: {
        status: 200,
        body: {
          id: 'synthetic-scroll-response',
          status: 'completed',
          output: Array.from({ length: 12 }, (_, index) => [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: `Synthetic reasoning ${index}` }],
            },
            {
              type: 'function_call',
              name: 'synthetic_exec',
              call_id: `synthetic-scroll-${index}`,
              arguments: JSON.stringify({ command: `synthetic command ${index}` }),
            },
            {
              type: 'function_call_output',
              call_id: `synthetic-scroll-${index}`,
              output: `Synthetic tool result ${index}
${'中文\u0000😀'.repeat(1330)}`,
            },
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: `Synthetic answer ${index}
${'测试\u0001😀'.repeat(1330)}`,
                },
              ],
            },
          ]).flat(),
        },
      },
    },
  };
  const scrollRecord = await store.ingest(Buffer.from(JSON.stringify(scroll)));
  const scrollConversation = store.db
    .query<{ conversation_id: number }, [number]>('SELECT conversation_id FROM requests WHERE id=?')
    .get(scrollRecord.id)!.conversation_id;
  const pageBytes: number[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = fragments(
      store,
      scrollConversation,
      new URLSearchParams(cursor ? { cursor } : {}),
    );
    const size = Buffer.byteLength(JSON.stringify(page));
    if (size > 65536) throw new Error('synthetic_page_budget');
    pageBytes.push(size);
    cursor = page.cursor;
    if (cursor) {
      if (seen.has(cursor) || !page.fragments.length) throw new Error('synthetic_cursor_progress');
      seen.add(cursor);
    }
    if (pageBytes.length > 100) throw new Error('synthetic_page_count');
  } while (cursor);
  if (pageBytes.length < 2) throw new Error('synthetic_second_page_required');
  const rows = store.db
    .query(
      'SELECT id,conversation_id,turn_index,parent_id,link_rule,parent_coverage,completeness FROM requests ORDER BY id',
    )
    .all();
  console.log(
    JSON.stringify({
      database,
      source: 'synthetic',
      records: 5,
      scrolling: {
        recordId: scrollRecord.id,
        conversationId: scrollConversation,
        pageCount: pageBytes.length,
        pageBytes,
      },
      rows,
      adminUser: 'demo',
      adminPassword: 'synthetic-demo-password',
      ingestToken: 'synthetic-demo-ingest-token',
    }),
  );
} finally {
  store.close();
}
