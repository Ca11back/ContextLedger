import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { hash } from '../src/server/codec';

const plugin = readFileSync(
  new URL('../plugins/ca11back_contextledger/plugin.js', import.meta.url),
  'utf8',
).replaceAll('export ', '');
export interface Transfer {
  serialized: string;
  manifest: any;
  manifestBody: string;
  objects: { hash: string; data: string; bytes: number }[];
  refs: [string, number][];
}
export function transfer(envelope: unknown): Transfer {
  return runInNewContext(plugin + '\npartitionEnvelope(envelope);', {
    envelope,
    TextEncoder,
    utils: { sha256: hash },
  });
}
export function profile(record: unknown, ctx = { format: 'openai_responses' }): any {
  return runInNewContext(plugin + '\nnormalizeReport(ctx,record);', { ctx, record, TextEncoder });
}
export function literalManifest(
  body: string,
  source = 'synthetic',
  id = JSON.parse(body).upload_id,
) {
  return {
    wire_version: 2,
    op: 'manifest',
    source,
    upload_id: id,
    envelope_hash: hash(body),
    envelope_bytes: Buffer.byteLength(body),
    recipe: [['l', body]],
    priority: [],
    hint: { request_id: '', context: { format: '', model: '' } },
  };
}
export function objectBody(t: Transfer, indices: number[]) {
  return JSON.stringify({
    wire_version: 2,
    op: 'objects',
    source: t.manifest.source,
    upload_id: t.manifest.upload_id,
    objects: indices.map((i) => ({ hash: t.objects[i]!.hash, data: t.objects[i]!.data })),
  });
}
export function batches(t: Transfer, indices: number[], cap = 1048576) {
  const batches: number[][] = [];
  let batch: number[] = [];
  for (const i of indices) {
    if (Buffer.byteLength(objectBody(t, [...batch, i])) > cap) {
      batches.push(batch);
      batch = [];
    }
    batch.push(i);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
