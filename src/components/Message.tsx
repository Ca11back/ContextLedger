import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { firstLines, lineCount } from '../client/format';
import { textQuery } from '../client/queries';
import type { AppSearch } from '../client/search';
import { appendChunk, type MessageView, type PartView } from '../client/transcript';
import type { MessageKind, TextChunk } from '../conversation-contracts';
import { SearchBlock } from './Search';

const kindLabel: Record<MessageKind, string> = {
  system: '系统提示',
  user: '用户',
  assistant: '助手',
  reasoning: '思考摘要',
  tool_call: '调用工具',
  tool_result: '工具结果',
  media: '附件',
  refusal: '拒绝回答',
  context: '上下文控制项',
  other: '其他内容',
};

/** Lines shown before folding, per kind. null = never folded by lines. */
const foldLines: Record<MessageKind, number | null> = {
  system: 0,
  user: null,
  assistant: null,
  reasoning: 3,
  tool_call: 8,
  tool_result: 3,
  media: null,
  refusal: null,
  context: 0,
  other: 6,
};

/** Characters shown before folding, per kind (long single lines also fold). */
const foldChars: Record<MessageKind, number | null> = {
  system: 0,
  user: null,
  assistant: null,
  reasoning: 400,
  tool_call: 800,
  tool_result: 400,
  media: null,
  refusal: null,
  context: 0,
  other: 600,
};

function Part({ message, part }: { message: MessageView; part: PartView }) {
  const client = useQueryClient();
  const [extra, setExtra] = useState<TextChunk[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Local copy with expanded chunks appended in order; appendChunk rejects gaps and repeats.
  const view: MessageView = { ...message, parts: [{ ...part }] };
  for (const chunk of extra) appendChunk(view, chunk);
  const merged = view.parts[0] ?? part;
  const limit = foldLines[message.kind];
  const lines = lineCount(merged.text);
  const charLimit = foldChars[message.kind];
  const tooLong =
    (limit !== null && lines > limit) || (charLimit !== null && merged.text.length > charLimit);
  const folded = !open && tooLong;
  const preview =
    limit === 0 || charLimit === 0
      ? ''
      : firstLines(merged.text, limit ?? Number.MAX_SAFE_INTEGER).slice(0, charLimit ?? undefined);
  const shown = folded ? (preview ? `${preview}…` : '') : merged.text;
  const loadMore = async () => {
    if (!merged.continuation) return;
    setLoading(true);
    setFailed(null);
    try {
      const chunk = await client.fetchQuery(textQuery(merged.continuation));
      setExtra((previous) => [...previous, chunk]);
      setOpen(true);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : '读取失败');
    } finally {
      setLoading(false);
    }
  };
  const mono =
    merged.partKind === 'json' ||
    ['tool_call', 'tool_result', 'other', 'context'].includes(message.kind);
  return (
    <div className="part">
      {shown && <div className={mono ? 'text mono-block' : 'text'}>{shown}</div>}
      {(folded || merged.continuation || (open && tooLong)) && (
        <div className="part-actions">
          {folded && (
            <button type="button" className="link small" onClick={() => setOpen(true)}>
              {limit === 0 ? '展开' : '展开全部'}（
              {lines > 1 ? `共 ${lines.toLocaleString()} 行，` : ''}
              {merged.continuation
                ? `已载入 ${merged.text.length.toLocaleString()} / ${merged.partTotal.toLocaleString()} 字`
                : `${merged.partTotal.toLocaleString()} 字`}
              ）
            </button>
          )}
          {!folded && merged.continuation && (
            <button
              type="button"
              className="link small"
              disabled={loading}
              onClick={() => void loadMore()}
            >
              {loading
                ? '正在载入…'
                : `继续载入（已显示 ${merged.text.length.toLocaleString()} / ${merged.partTotal.toLocaleString()} 字）`}
            </button>
          )}
          {open && tooLong && (
            <button type="button" className="link small" onClick={() => setOpen(false)}>
              收起
            </button>
          )}
          {failed && <span className="danger small">{failed}</span>}
        </div>
      )}
    </div>
  );
}

const mediaNames: Record<string, string> = {
  input_image: '图片',
  image_url: '图片',
  image: '图片',
  input_audio: '音频',
  input_file: '文件',
};

function mediaLabel(label: string) {
  return mediaNames[label] ?? label;
}

/**
 * `pending`: the stream may still deliver this message's first chunks (it is the last
 * message received and more pages exist). Otherwise a header without parts means the
 * content never arrived.
 */
export function Message({
  message,
  pending = false,
  search = {},
}: {
  message: MessageView;
  pending?: boolean;
  /** Current URL state, kept by links to linked search requests. */
  search?: AppSearch;
}) {
  const label =
    message.kind === 'tool_call' || message.kind === 'tool_result'
      ? `${kindLabel[message.kind]}${message.name ? ` · ${message.name}` : ''}`
      : message.kind === 'other' && message.role
        ? `${kindLabel.other} · ${message.role}`
        : kindLabel[message.kind];
  return (
    <div className={`msg msg-${message.kind}`}>
      <div className="who">
        {label}
        {message.side === 'output' && message.kind === 'user' ? ' · 回复' : ''}
      </div>
      {message.media && (
        <span className="media-chip">{mediaLabel(message.media.label)} · 已由网关遮罩</span>
      )}
      {message.searches?.map((summary) => (
        <SearchBlock key={summary.recordId} summary={summary} search={search} />
      ))}
      {message.parts.map((part) => (
        <Part key={part.partIndex} message={message} part={part} />
      ))}
      {message.parts.length === 0 && !message.media && message.partCount > 0 && (
        <p className="muted small">{pending ? '正在载入…' : '这段内容没有返回，可查看原始数据'}</p>
      )}
      {message.alternatives ? (
        <p className="muted small">另有 {message.alternatives} 个候选回复，可在原始数据中查看。</p>
      ) : null}
    </div>
  );
}

/**
 * A reasoning message with nothing readable: no parts or only blank text (e.g. encrypted
 * reasoning without a summary). A message whose parts may still arrive is never empty.
 */
function emptyReasoning(message: MessageView, pending: boolean) {
  return (
    message.kind === 'reasoning' &&
    !pending &&
    !message.alternatives &&
    !message.media &&
    message.parts.every((part) => !part.continuation && part.text.trim() === '')
  );
}

type MessageRun =
  | { type: 'message'; message: MessageView }
  | { type: 'reasoning'; key: string; count: number };

/** Groups consecutive empty reasoning messages into one run; everything else stays as is. */
export function groupMessages(messages: readonly MessageView[], pendingId?: string): MessageRun[] {
  const runs: MessageRun[] = [];
  for (const message of messages) {
    if (!emptyReasoning(message, message.messageId === pendingId)) {
      runs.push({ type: 'message', message });
      continue;
    }
    const last = runs.at(-1);
    if (last?.type === 'reasoning') last.count += 1;
    else runs.push({ type: 'reasoning', key: message.messageId, count: 1 });
  }
  return runs;
}

/** Messages in order, with runs of empty reasoning merged into one muted line. */
export function MessageList({
  messages,
  pendingId,
  search,
}: {
  messages: readonly MessageView[];
  pendingId?: string;
  search?: AppSearch;
}) {
  return (
    <>
      {groupMessages(messages, pendingId).map((run) =>
        run.type === 'message' ? (
          <Message
            key={run.message.messageId}
            message={run.message}
            pending={run.message.messageId === pendingId}
            search={search}
          />
        ) : (
          <p className="msg reasoning-run muted small" key={run.key}>
            模型思考了 {run.count.toLocaleString()} 步（内容已加密，未记录）
          </p>
        ),
      )}
    </>
  );
}

export function LeadingHistory({
  messages,
  label,
  pendingId,
  search,
}: {
  messages: MessageView[];
  label: string;
  pendingId?: string;
  search?: AppSearch;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="carried">
      <div className="carried-bar">
        <span>
          {label}（{messages.length.toLocaleString()} 条消息，不计时间与费用）
        </span>
        <button type="button" className="link small" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open && <MessageList messages={messages} pendingId={pendingId} search={search} />}
    </div>
  );
}
