import { createFileRoute } from '@tanstack/react-router';
import { conversationHttp } from '../server/conversation-api';
import { ledger } from '../server/runtime';
export const Route = createFileRoute('/api/requests/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => conversationHttp(request, ledger(), 'request', params.id),
    },
  },
});
