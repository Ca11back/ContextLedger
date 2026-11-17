import { createFileRoute } from '@tanstack/react-router';
import { conversationHttp } from '../server/conversation-api';
import { ledger } from '../server/runtime';
export const Route = createFileRoute('/api/conversations/$id/subagents')({
  server: {
    handlers: {
      GET: ({ request, params }) => conversationHttp(request, ledger(), 'subagents', params.id),
    },
  },
});
