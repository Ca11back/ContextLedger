import { bytes, dateTime } from '../client/format';
import type { UploadState } from '../client-contracts';
import { Empty } from './Feedback';

const states: Record<string, string> = {
  complete: '已校验拼装',
  partial: '部分上传',
  expired: '已过期',
  failed: '失败',
};
export function Uploads({
  uploads,
  select,
}: {
  uploads: UploadState[];
  select: (id: number) => void;
}) {
  return (
    <section className="uploads-panel">
      <div className="info-note">
        部分上传、过期和失败均不代表完整记录。生产方提示未经独立校验；缺失内容不可查看。这里只保留有限的近期传输回执。
      </div>
      {uploads.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>上传 ID / 生产方提示</th>
                <th>传输状态</th>
                <th>尚缺内容</th>
                <th>过期 / 完成时间</th>
                <th>记录</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((upload) => (
                <tr key={upload.upload_id}>
                  <td>
                    <code className="upload-id">{upload.upload_id}</code>
                    <small>
                      {upload.hint?.request_id || '无请求提示'} ·{' '}
                      {upload.hint?.context?.model || '未知模型'}
                    </small>
                    <small>生产方提示 · 未经独立校验</small>
                  </td>
                  <td>
                    <span
                      className={`pill ${upload.state === 'complete' ? 'success' : upload.state === 'partial' ? 'warning' : 'danger'}`}
                    >
                      {states[upload.state] ?? upload.state}
                    </span>
                    <small>{upload.reason}</small>
                  </td>
                  <td>
                    {upload.missing_count.toLocaleString()} 片
                    <small>{bytes(upload.missing_bytes)}</small>
                  </td>
                  <td>
                    {dateTime(upload.completed_at ?? upload.expires_at)}
                    <small>{upload.completed_at === null ? '过期时间' : '拼装完成时间'}</small>
                  </td>
                  <td>
                    {upload.state === 'complete' && upload.record_id ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => select(upload.record_id as number)}
                      >
                        查看 #{upload.record_id}
                      </button>
                    ) : (
                      <span className="muted">无已校验记录</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="暂无传输回执">收到上传后，会在这里显示拼装进度和缺失内容。</Empty>
      )}
    </section>
  );
}
