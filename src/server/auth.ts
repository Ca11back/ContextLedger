import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config';
import { LedgerError } from './errors';

function equal(left: string, right: string) {
  const a = new Bun.CryptoHasher('sha256').update(left).digest();
  const b = new Bun.CryptoHasher('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}
export function requireAdmin(request: Request, config: Config) {
  const value = request.headers.get('authorization') ?? '';
  let supplied = '';
  try {
    if (value.startsWith('Basic '))
      supplied = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(value.slice(6), 'base64'),
      );
  } catch {
    /* reject */
  }
  if (!equal(supplied, `${config.adminUser}:${config.adminPassword}`)) {
    throw new LedgerError(401, 'administrator_auth_required');
  }
}
export function requireIngest(request: Request, config: Config) {
  if (!equal(request.headers.get('authorization') ?? '', `Bearer ${config.ingestToken}`))
    throw new LedgerError(401, 'ingest_auth_required');
}
export function privateHeaders(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  if (response.status === 401)
    response.headers.set('WWW-Authenticate', 'Basic realm="ContextLedger", charset="UTF-8"');
  return response;
}
