import { createFileRoute } from '@tanstack/react-router';
import { boundedJson } from '../server/conversation-api';
import { adminHttp } from '../server/http';
import { ledger } from '../server/runtime';
export const Route = createFileRoute('/api/metrics')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const store = ledger();
        return adminHttp(request, store, () => boundedJson(store.metrics()));
      },
    },
  },
});
