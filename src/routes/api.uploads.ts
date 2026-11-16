import { createFileRoute } from '@tanstack/react-router';
import { adminHttp } from '../server/http';
import { ledger, transport } from '../server/runtime';
export const Route = createFileRoute('/api/uploads')({
  server: {
    handlers: { GET: ({ request }) => adminHttp(request, ledger(), () => transport().list()) },
  },
});
