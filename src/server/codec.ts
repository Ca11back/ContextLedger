import { LedgerError } from './errors';
export const hash = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
export type Part = { literal: string } | { hash: string };
export interface PreparedObject {
  hash: string;
  length: number;
  compressed: Uint8Array;
}
export interface Prepared {
  mode: 'item_cas' | 'whole_zstd';
  hash: string;
  length: number;
  payload: Uint8Array;
  objects: Map<string, PreparedObject>;
  refs: string[];
}
const fragmentArrays = new Set(['input', 'messages', 'tools', 'output', 'events']);
// Locate exact JSON value spans. Parsing is only used for validation/metadata;
// slices preserve duplicate members, whitespace, number spelling and escapes.
function spans(json: string): Array<[number, number]> {
  let pos = 0;
  const found: Array<[number, number]> = [];
  const space = () => {
    while (/\s/.test(json[pos] ?? '') && pos < json.length) pos++;
  };
  const string = () => {
    const start = pos++;
    while (pos < json.length) {
      if (json[pos++] === '"') return json.slice(start, pos);
      if (json[pos - 1] === '\\') pos++;
    }
    throw new Error('string');
  };
  function value(key = '', depth = 0): void {
    if (depth > 128) throw new Error('depth');
    space();
    const begin = pos;
    if (json[pos] === '{') {
      pos++;
      space();
      while (json[pos] !== '}') {
        const name = JSON.parse(string()) as string;
        space();
        if (json[pos++] !== ':') throw new Error('colon');
        value(name, depth + 1);
        space();
        if (json[pos] !== ',') break;
        pos++;
        space();
      }
      if (json[pos++] !== '}') throw new Error('object');
    } else if (json[pos] === '[') {
      pos++;
      space();
      while (json[pos] !== ']') {
        const start = pos;
        const count = found.length;
        value('', depth + 1);
        if (fragmentArrays.has(key)) {
          found.splice(count);
          found.push([start, pos]);
        }
        space();
        if (json[pos] !== ',') break;
        pos++;
        space();
      }
      if (json[pos++] !== ']') throw new Error('array');
    } else if (json[pos] === '"') string();
    else {
      while (pos < json.length && !/[\s,\]}]/.test(json[pos]!)) pos++;
      if (pos === begin) throw new Error('primitive');
    }
    if (key === 'instructions' || (key === 'input' && json[begin] !== '[')) {
      while (found.length && found[found.length - 1]![0] >= begin) found.pop();
      found.push([begin, pos]);
    }
  }
  value();
  space();
  if (pos !== json.length) throw new Error('trailing');
  return found.sort((a, b) => a[0] - b[0]);
}
export async function prepare(bytes: Uint8Array, forceWhole = false): Promise<Prepared> {
  const bodyHash = hash(bytes),
    objects = new Map<string, PreparedObject>();
  const whole = async (): Promise<Prepared> => {
    const payload = await Bun.zstdCompress(bytes);
    const restored = await Bun.zstdDecompress(payload);
    verify(restored, bodyHash, bytes.length);
    return {
      mode: 'whole_zstd',
      hash: bodyHash,
      length: bytes.length,
      payload,
      objects: new Map(),
      refs: [],
    };
  };
  if (forceWhole) return whole();
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const selected = spans(json);
    if (!selected.length || selected.length > 8192) return whole();
    const parts: Part[] = [];
    let end = 0;
    for (const [start, stop] of selected) {
      if (start < end) throw new Error('overlap');
      if (start > end) parts.push({ literal: json.slice(end, start) });
      const fragment = Buffer.from(json.slice(start, stop));
      const digest = hash(fragment);
      if (!objects.has(digest))
        objects.set(digest, {
          hash: digest,
          length: fragment.length,
          compressed: await Bun.zstdCompress(fragment),
        });
      parts.push({ hash: digest });
      end = stop;
      // Yield between bounded compression work, never within a transaction.
      if (parts.length % 64 === 0) await Bun.sleep(0);
    }
    if (end < json.length) parts.push({ literal: json.slice(end) });
    const restored = Buffer.concat(
      parts.map((p) =>
        'literal' in p
          ? Buffer.from(p.literal)
          : Bun.zstdDecompressSync(objects.get(p.hash)!.compressed),
      ),
    );
    if (
      restored.length !== bytes.length ||
      hash(restored) !== bodyHash ||
      !Buffer.from(bytes).equals(restored)
    )
      return whole();
    return {
      mode: 'item_cas',
      hash: bodyHash,
      length: bytes.length,
      payload: await Bun.zstdCompress(JSON.stringify(parts)),
      objects,
      refs: [...objects.keys()],
    };
  } catch {
    return whole();
  }
}
export function decodeParts(payload: Uint8Array): Part[] {
  try {
    const parts: unknown = JSON.parse(Bun.zstdDecompressSync(payload).toString());
    if (
      !Array.isArray(parts) ||
      parts.some(
        (p) =>
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          Object.keys(p).length !== 1 ||
          !(
            typeof p.literal === 'string' ||
            (typeof p.hash === 'string' && /^[a-f0-9]{64}$/.test(p.hash))
          ),
      )
    )
      throw new Error();
    return parts;
  } catch {
    throw new LedgerError(500, 'manifest_integrity_error');
  }
}
export function verify(bytes: Uint8Array, expectedHash: string, length: number) {
  if (bytes.length !== length || hash(bytes) !== expectedHash)
    throw new LedgerError(500, 'body_integrity_error');
}
