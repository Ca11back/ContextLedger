import { privateHeaders, requireAdmin, requireIngest } from './auth';
import { ingestDiagnostic } from './diagnostics';
import { failure, LedgerError } from './errors';
import type { Ledger } from './storage';
import { Transport } from './transport';
export async function readBounded(
  request: Request,
  max: number,
  observe: (size: number) => void = () => undefined,
) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) throw new LedgerError(413, 'body_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new LedgerError(400, 'empty_body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      observe(size);
      if (size > max) {
        await reader.cancel();
        throw new LedgerError(413, 'body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function ingestHttp(
  request: Request,
  store: Ledger,
  receiver: Transport = new Transport(store),
) {
  const started = performance.now();
  let receivedBytes = 0;
  try {
    requireIngest(request, store.config);
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      throw new LedgerError(415, 'json_required');
    const result = await receiver.receive(
      await readBounded(request, store.config.maxBodyBytes, (size) => {
        receivedBytes = size;
      }),
    );
    const status = result.state === 'complete' ? 200 : 202;
    ingestDiagnostic(
      status,
      result.state === 'complete' ? 'stored' : 'staged',
      receivedBytes,
      performance.now() - started,
    );
    return privateHeaders(Response.json(result, { status }));
  } catch (error) {
    const response = privateHeaders(failure(error));
    ingestDiagnostic(
      response.status,
      error instanceof LedgerError ? error.code : 'internal_error',
      receivedBytes,
      performance.now() - started,
    );
    return response;
  }
}
export function adminHttp(request: Request, store: Ledger, action: () => unknown) {
  try {
    requireAdmin(request, store.config);
    return privateHeaders(Response.json(action()));
  } catch (error) {
    return privateHeaders(failure(error));
  }
}
