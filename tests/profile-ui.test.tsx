import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDashboardQueryClient, recordViewQuery } from '../src/client/queries';
import { RecordInspector } from '../src/components/RecordInspector';
import { Uploads } from '../src/components/Uploads';
import type { RecordView } from '../src/view-contracts';

test('shipped inspector escapes report metadata and states capture and cost boundaries', () => {
  const client = createDashboardQueryClient();
  const view: RecordView = {
    meta: {
      id: 1,
      received_at: 0,
      source: '<script>source</script>',
      upload_id: 'synthetic-upload',
      host_request_id: '<img src="https://private.example/picture">',
      model: '<script>model</script>',
      channel: 'synthetic-channel',
      user_label: 'synthetic-user',
      token_label: 'synthetic-token',
      outcome: 'reported',
      truncated: 1,
      media: 1,
      duration_ms: null,
      usage_json: '{}',
      cost_json: '{}',
      body_hash: 'a'.repeat(64),
      body_length: 1000,
      storage_mode: 'item_cas',
    },
    path: [],
    node: { kind: 'object', preview: '', count: 1 },
    entries: [],
    text: null,
    offset: 0,
    nextOffset: null,
    total: 1,
    sections: [{ id: 'raw', label: '完整结构', path: [] }],
  };
  client.setQueryData(recordViewQuery(1, [], 0).queryKey, view);
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RecordInspector id={1} close={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain('&lt;script&gt;model&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;source&lt;/script&gt;');
    expect(html).toContain('&lt;img src=');
    expect(html).toContain('网关已截断，部分内容缺失');
    expect(html).toContain('内联媒体已遮罩');
    expect(html).toContain('上游采购成本');
    expect(html).toContain('未知');
    expect(html).toContain('链接保持文本，不加载外部资源');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
  } finally {
    client.clear();
  }
});

test('shipped upload panel escapes unverified hints without presenting partial evidence as complete', () => {
  const html = renderToStaticMarkup(
    <Uploads
      uploads={[
        {
          upload_id: 'synthetic-upload',
          state: 'partial',
          reason: '<script>reason</script>',
          created_at: 0,
          expires_at: 1000,
          completed_at: null,
          record_id: null,
          envelope_bytes: 1000,
          missing_count: 2,
          missing_bytes: 500,
          hint: {
            request_id: '<img src="https://private.example/picture">',
            context: { model: '<script>model</script>' },
          },
          hint_verified: false,
        },
      ]}
      select={() => {}}
    />,
  );
  expect(html).toContain('部分上传');
  expect(html).toContain('生产方提示 · 未经独立校验');
  expect(html).toContain('无已校验记录');
  expect(html).toContain('&lt;script&gt;model&lt;/script&gt;');
  expect(html).toContain('&lt;script&gt;reason&lt;/script&gt;');
  expect(html).toContain('&lt;img src=');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('href=');
  expect(html).not.toContain('查看 #');
});
