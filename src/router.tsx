import { createRouter } from '@tanstack/react-router';
import { createDashboardQueryClient } from './client/queries';
import { routeTree } from './routeTree.gen';
export function getRouter() {
  const queryClient = createDashboardQueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: false,
  });
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
