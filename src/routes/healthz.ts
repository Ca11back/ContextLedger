import { createFileRoute } from '@tanstack/react-router';
import { version } from '../../package.json';
import { ledger } from '../server/runtime';
import { SUPPORTED_WIRE_VERSIONS } from '../server/transport';

export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () => {
        ledger();
        return Response.json({
          status: 'ok',
          service: 'contextledger',
          version,
          wire: SUPPORTED_WIRE_VERSIONS,
        });
      },
    },
  },
});
