import { createFileRoute } from '@tanstack/react-router';
import { LedgerError } from '../server/errors';
import { adminHttp } from '../server/http';
import { ledger } from '../server/runtime';
export const Route = createFileRoute('/api/records/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        const store = ledger();
        return adminHttp(request, store, () => {
          if (!/^\d+$/.test(params.id)) throw new LedgerError(400, 'invalid_id');
          return store.detail(Number(params.id));
        });
      },
    },
  },
});
