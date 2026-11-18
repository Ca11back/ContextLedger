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

/** Gateway charge in quota units; a known value is always a complete total. */
export function charge(quota: number | null | undefined) {
  if (quota === null || quota === undefined) return '费用未知';
  return `${quota.toLocaleString()} quota`;
}

const usdSmall = new Intl.NumberFormat('en-US', {
  minimumSignificantDigits: 2,
  maximumSignificantDigits: 2,
});
const usdLarge = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Gateway charge in USD: two decimals from $1, two significant digits below; null = unknown. */
export function usd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '费用未知';
  const text =
    value === 0 ? '0.00' : Math.abs(value) >= 1 ? usdLarge.format(value) : usdSmall.format(value);
  return `$${text}`;
}

/**
 * Cost label: "$0.12 · 12,000 quota" when both units are known, whichever is known otherwise,
 * null when neither. A known unit is always a complete total (the server nulls incomplete sums).
 */
export function cost(quota: number | null | undefined, usdValue: number | null | undefined) {
  const parts: string[] = [];
  if (usdValue !== null && usdValue !== undefined && Number.isFinite(usdValue))
    parts.push(usd(usdValue));
  if (quota !== null && quota !== undefined) parts.push(charge(quota));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Muted note beside conversation totals when some own turn's charge is unknown in some unit. */
export const partialChargeNote = '部分轮次费用未知';

/** Cache hit share as a percentage label; null when either value is unknown or the total is 0. */
export function hitRate(read: number | null | undefined, total: number | null | undefined) {
  if (read === null || read === undefined || total === null || total === undefined || total <= 0)
    return null;
  const share = Math.min(1, read / total) * 100;
  if (share > 0 && share < 0.5) return '<1%';
  return `${Math.round(share)}%`;
}

/** "缓存命中 142,000（95%）"; null when cache reads are unknown. */
export function cacheHit(read: number | null | undefined, total: number | null | undefined) {
  if (read === null || read === undefined) return null;
  const rate = hitRate(read, total);
  return `缓存命中 ${read.toLocaleString()}${rate ? `（${rate}）` : ''}`;
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
