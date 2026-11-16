import { createFileRoute } from '@tanstack/react-router';
import { ingestHttp } from '../server/http';
import { ledger, transport } from '../server/runtime';
export const Route = createFileRoute('/api/ingest')({
  server: { handlers: { POST: ({ request }) => ingestHttp(request, ledger(), transport()) } },
});
