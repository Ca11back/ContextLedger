import { object } from '../contracts';
export function bytes(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} KB`;
  return `${n} B`;
}
export function dateTime(n: number) {
  return new Date(n).toLocaleString('zh-CN', { hour12: false });
}
export function jsonNumbers(value: string) {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}
export function usage(value: string) {
  const data = jsonNumbers(value);
  return {
    input: typeof data.promptTokens === 'number' ? data.promptTokens.toLocaleString() : '未知',
    output:
      typeof data.completionTokens === 'number' ? data.completionTokens.toLocaleString() : '未知',
    cache: typeof data.cacheTokens === 'number' ? data.cacheTokens.toLocaleString() : '未知',
    total: typeof data.totalTokens === 'number' ? data.totalTokens.toLocaleString() : '未知',
  };
}
export function charge(value: string) {
  const data = jsonNumbers(value);
  return typeof data.usd === 'number'
    ? `$${data.usd}`
    : typeof data.quota === 'number'
      ? `${data.quota} quota`
      : '未知';
}
