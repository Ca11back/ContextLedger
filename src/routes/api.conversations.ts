import { createFileRoute } from '@tanstack/react-router';
import { conversationHttp } from '../server/conversation-api';
import { ledger } from '../server/runtime';
export const Route = createFileRoute('/api/conversations')({
  server: {
    handlers: { GET: ({ request }) => conversationHttp(request, ledger(), 'conversations') },
  },
});
