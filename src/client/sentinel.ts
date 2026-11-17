import { useCallback, useEffect, useState } from 'react';

/** Delay before the quiet manual "继续载入" control appears when nothing started loading. */
export const STALL_MS = 1500;

type ObserverLike = { observe(node: Element): void; disconnect(): void };
export type ObserverFactory = (
  callback: (entries: { isIntersecting: boolean }[]) => void,
) => ObserverLike;

const browserObserver: ObserverFactory | null =
  typeof IntersectionObserver === 'undefined'
    ? null
    : (callback) => new IntersectionObserver(callback, { rootMargin: '200px 0px' });

/**
 * Observes one sentinel node and calls `load` when it intersects. A fresh observer
 * always reports the node's current state first, so re-watching after a page
 * arrives loads the next page when the sentinel is still on screen.
 */
export function watchSentinel(
  node: Element,
  load: () => void,
  create: ObserverFactory | null = browserObserver,
): () => void {
  if (!create) return () => {};
  let fired = false;
  const observer = create((entries) => {
    if (fired || !entries.some((entry) => entry.isIntersecting)) return;
    fired = true;
    load();
  });
  observer.observe(node);
  return () => observer.disconnect();
}

/** Reports every visibility change of the sentinel (for the manual fallback). */
export function trackSentinel(
  node: Element,
  onChange: (visible: boolean) => void,
  create: ObserverFactory | null = browserObserver,
): () => void {
  if (!create) return () => {};
  const observer = create((entries) => {
    const last = entries.at(-1);
    if (last) onChange(last.isIntersecting);
  });
  observer.observe(node);
  return () => observer.disconnect();
}

/**
 * Whether the quiet manual fallback is offered: more pages exist, nothing is loading,
 * and either the last page failed or the sentinel has been visible for STALL_MS
 * without a load starting.
 */
export function manualLoadState(input: {
  hasNextPage: boolean;
  isFetching: boolean;
  failed: boolean;
  stalled: boolean;
}): boolean {
  if (!input.hasNextPage || input.isFetching) return false;
  return input.failed || input.stalled;
}

/**
 * Auto-loads the next page through a callback-ref sentinel. The observer attaches
 * whenever the sentinel mounts (independent of query timing) and is re-created each
 * time a fetch ends. A failed page is not retried automatically. Returns the ref and
 * whether to show the quiet "继续载入" fallback.
 */
export function useSentinel({
  hasNextPage,
  isFetching,
  failed,
  load,
}: {
  hasNextPage: boolean;
  isFetching: boolean;
  failed: boolean;
  load: () => void;
}) {
  const [node, setNode] = useState<Element | null>(null);
  const ref = useCallback((element: Element | null) => setNode(element), []);
  const enabled = hasNextPage && !isFetching && !failed;
  useEffect(() => {
    if (!node || !enabled) return;
    return watchSentinel(node, load);
  }, [node, enabled, load]);
  // Visibility is tracked separately so the fallback appears only at the bottom.
  // Without IntersectionObserver the sentinel counts as visible.
  const [visible, setVisible] = useState(browserObserver === null);
  useEffect(() => {
    if (!node) return;
    return trackSentinel(node, setVisible);
  }, [node]);
  const [stalled, setStalled] = useState(false);
  const idle = hasNextPage && !isFetching && visible;
  useEffect(() => {
    setStalled(false);
    if (!idle) return;
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [idle]);
  return { ref, showManual: manualLoadState({ hasNextPage, isFetching, failed, stalled }) };
}
