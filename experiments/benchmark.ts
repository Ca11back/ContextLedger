import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../src/server/codec';
import { Ledger } from '../src/server/storage';

function argument(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value) throw new Error(`Supply ${name}`);
  return value;
}
const output = resolve(argument('--output')),
  seed = Number(argument('--seed', '1116')),
  runs = Number(argument('--runs', '1'));
if (!Number.isInteger(seed) || !Number.isInteger(runs) || runs < 1 || runs > 5)
  throw new Error('Invalid seed/runs');
mkdirSync(output, { recursive: false });
function rng(initial: number) {
  let state = initial >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
const results: unknown[] = [];
const quantile = (times: number[], p: number) =>
  times.sort((a, b) => a - b)[Math.min(times.length - 1, Math.floor(times.length * p))];
for (let run = 0; run < runs; run++)
  for (const turns of [50, 100, 500])
    for (const whole of [true, false]) {
      const random = rng(seed),
        history: unknown[] = [],
        directory = join(output, `${run}-${turns}-${whole ? 'whole' : 'cas'}`);
      mkdirSync(directory);
      const store = new Ledger({
        database: join(directory, 'ledger.sqlite'),
        maxStorageBytes: 1024 * 1024 * 1024,
        reserveBytes: 8 * 1024 * 1024,
        maxBodyBytes: 16 * 1024 * 1024,
        adminUser: 'admin',
        adminPassword: 'synthetic-admin-password',
        ingestToken: 'synthetic-ingest-token-12345678',
        source: 'synthetic',
        maintenanceMs: 30000,
      });
      const started = performance.now(),
        cpu = process.cpuUsage(),
        insertion: number[] = [],
        restoration: number[] = [],
        ids: number[] = [];
      let receivedBytes = 0,
        walHigh = 0;
      for (let turn = 0; turn < turns; turn++) {
        const entropy = Array.from({ length: 100 }, () => random().toString(36)).join('');
        history.push(
          { role: 'user', content: `Synthetic 中文 😀 turn ${turn} ${entropy}` },
          { type: 'function_call_output', call_id: `call-${turn}`, output: entropy },
        );
        const body = Buffer.from(
          JSON.stringify({
            version: 1,
            upload_id: `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`,
            source: 'synthetic',
            context: { model: 'synthetic' },
            report: {
              requestId: `seed-${seed}-${turn}`,
              request: {
                body: {
                  instructions: 'Synthetic stable instructions '.repeat(80),
                  tools: [
                    {
                      type: 'function',
                      name: turn < turns / 2 ? 'toolA' : 'toolB',
                      parameters: { type: 'object' },
                    },
                  ],
                  input: history,
                },
              },
              response: {
                status: 200,
                truncated: turn % 37 === 0,
                events: [
                  {
                    event: 'future',
                    data: { type: 'unknown', text: entropy, encrypted_content: entropy },
                  },
                ],
              },
            },
          }),
        );
        receivedBytes += body.length;
        const begin = performance.now();
        const result = await store.ingest(body, { forceWhole: whole });
        insertion.push(performance.now() - begin);
        ids.push(result.id);
        walHigh = Math.max(walHigh, store.metrics().wal);
        const restoreBegin = performance.now();
        const restored = store.restore(result.id);
        restoration.push(performance.now() - restoreBegin);
        if (hash(restored) !== hash(body)) throw new Error('Benchmark restoration mismatch');
      }
      await store.maintain();
      const metrics = store.metrics(),
        usage = process.cpuUsage(cpu);
      results.push({
        run,
        turns,
        mode: whole ? 'whole_zstd' : 'item_cas',
        receivedBytes,
        metrics,
        walHigh,
        elapsedMs: performance.now() - started,
        cpuUserMs: usage.user / 1000,
        cpuSystemMs: usage.system / 1000,
        rss: process.memoryUsage().rss,
        insertionP50: quantile(insertion, 0.5),
        insertionP95: quantile(insertion, 0.95),
        restorationP50: quantile(restoration, 0.5),
        restorationP95: quantile(restoration, 0.95),
        integrity: store.integrity(),
      });
      store.close();
    }
const report = {
  format: 1,
  synthetic: true,
  seed,
  runs,
  bun: Bun.version,
  sqlite: 'bun:sqlite',
  durability: 'WAL FULL, auto_vacuum INCREMENTAL',
  codec: 'Bun Zstd default level',
  platform: process.platform,
  arch: process.arch,
  results,
};
writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
