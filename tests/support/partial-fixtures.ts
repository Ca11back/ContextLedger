/** Synthetic 41–44 tool-loop shape. No remote calls or source evidence. */
import type { Envelope } from '../../src/contracts';

export function partialLoopFixtures(): Envelope[] {
  const initial = [{ role: 'user', content: 'Synthetic ordered tool loop' }];
  const reasoning = { type: 'reasoning', id: 'synthetic-reasoning-41', summary: [] };
  const call41 = {
    type: 'function_call',
    id: 'synthetic-tool-41',
    call_id: 'synthetic-call-41',
    name: 'synthetic_tool',
    arguments: '{"step":1}',
  };
  const call42 = {
    type: 'function_call',
    id: 'synthetic-tool-42',
    call_id: 'synthetic-call-42',
    name: 'synthetic_tool',
    arguments: '{"step":2}',
  };
  const call43 = {
    type: 'function_call',
    id: 'synthetic-tool-43',
    call_id: 'synthetic-call-43',
    name: 'synthetic_tool',
    arguments: '{"step":3}',
  };
  const toolResult = (step: number) => ({
    type: 'function_call_output',
    call_id: `synthetic-call-${step}`,
    output: `Synthetic tool result ${step}`,
  });
  const input42 = [...initial, reasoning, call41, toolResult(41)];
  const input43 = [...input42, call42, toolResult(42)];
  const input44 = [
    ...input43,
    call43,
    toolResult(43),
    { role: 'user', content: 'Synthetic final suffix' },
  ];
  const inputs = [initial, input42, input43, input44];
  return inputs.map((input, index) => ({
    version: 1,
    source: 'synthetic',
    upload_id: crypto.randomUUID(),
    context: { format: 'openai_responses', model: 'synthetic-model' },
    report: {
      requestId: `synthetic-partial-${41 + index}`,
      user: { id: 1, username: 'synthetic-user' },
      token: { id: 2, name: 'synthetic-token' },
      usage: { promptTokens: 100, completionTokens: 10 },
      cost: { quota: 0 },
      request: {
        body: {
          input,
          client_metadata: {
            'x-codex-turn-metadata': JSON.stringify({
              thread_id: 'synthetic-partial-loop',
              session_id: 'synthetic-session',
            }),
          },
        },
      },
      response:
        index === 3
          ? {
              status: 200,
              body: {
                id: 'synthetic-response-44',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Synthetic completed answer' }],
                  },
                ],
              },
            }
          : {
              status: 200,
              truncated: true,
              stream: true,
              events:
                index === 0
                  ? [
                      {
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: { ...reasoning, status: 'in_progress' },
                      },
                      {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: { ...reasoning, status: 'completed' },
                      },
                      {
                        type: 'response.output_item.added',
                        output_index: 1,
                        item: { ...call41, arguments: '', status: 'in_progress' },
                      },
                      {
                        type: 'response.output_item.done',
                        output_index: 1,
                        item: { ...call41, status: 'completed' },
                      },
                    ]
                  : [
                      {
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: {
                          ...(index === 1 ? call42 : call43),
                          arguments: '',
                          status: 'in_progress',
                        },
                      },
                    ],
            },
    },
  }));
}
