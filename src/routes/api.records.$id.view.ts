import { createFileRoute } from '@tanstack/react-router';
import { recordViewHttp } from '../server/record-view';
import { ledger } from '../server/runtime';

export const Route = createFileRoute('/api/records/$id/view')({
  server: {
    handlers: {
      GET: ({ request, params }) => recordViewHttp(request, ledger(), params.id),
    },
  },
});
