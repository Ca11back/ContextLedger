export function bytes(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}

export function dateTime(n: number) {
  return new Date(n).toLocaleString('zh-CN', { hour12: false });
}

export function clock(n: number) {
  return new Date(n).toLocaleTimeString('zh-CN', { hour12: false });
}

/** Short relative label for list rows: time today, otherwise month/day time. */
export function when(n: number, now = Date.now()) {
  const date = new Date(n);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function count(n: number | null) {
  return n === null ? '未知' : n.toLocaleString();
}

export function tokens(input: number | null, output: number | null) {
  return `${count(input)} → ${count(output)} tokens`;
}

export function duration(ms: number | null) {
  if (ms === null) return '耗时未知';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function charge(quota: number | null, partial = false) {
  if (quota === null) return '费用未知';
  return `${partial ? '至少 ' : ''}${quota.toLocaleString()} quota`;
}

/** Middle ellipsis for long ids; the full value stays in title / copy. */
export function shortId(id: string, keep = 6) {
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep)}`;
}

export function lineCount(text: string) {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

export function firstLines(text: string, lines: number) {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++seen === lines) return text.slice(0, i);
  }
  return text;
}
