import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** Router context for rendering components that contain `Link`s outside the app shell. */
export function WithRouter({ children, url = '/' }: { children: ReactNode; url?: string }) {
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: '/' });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
}
