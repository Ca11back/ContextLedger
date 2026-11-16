export class LedgerError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function failure(error: unknown): Response {
  if (error instanceof LedgerError)
    return Response.json({ error: error.code }, { status: error.status });
  // Never log request bodies, database values, tokens or arbitrary exception messages.
  console.error(JSON.stringify({ event: 'ledger_error', code: 'internal_error' }));
  return Response.json({ error: 'internal_error' }, { status: 500 });
}
