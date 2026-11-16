import { createFileRoute } from '@tanstack/react-router';
import { adminHttp } from '../server/http';
import { ledger } from '../server/runtime';
export const Route = createFileRoute('/api/metrics')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const store = ledger();
        return adminHttp(request, store, () => store.metrics());
      },
    },
  },
});
