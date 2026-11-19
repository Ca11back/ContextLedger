import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { privateHeaders, requireAdmin } from './server/auth';
import { failure } from './server/errors';
import { ledger, startMaintenance } from './server/runtime';

const start = createStartHandler(defaultStreamHandler);
export default {
  initialize: startMaintenance,
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    try {
      // Defense in depth for pages and any future direct server functions. API handlers also authorize individually.
      if (path !== '/api/ingest' && path !== '/healthz') requireAdmin(request, ledger().config);
      startMaintenance();
      return privateHeaders(await start(request));
    } catch (error) {
      return privateHeaders(failure(error));
    }
  },
};
