import { useCallback, useEffect, useMemo, useState } from 'react';

/** Delay before the quiet manual "继续载入" control appears when nothing started loading. */
export const STALL_MS = 1500;

type ObserverLike = { observe(node: Element): void; disconnect(): void };
export type ObserverFactory = (
  callback: (entries: { isIntersecting: boolean }[]) => void,
) => ObserverLike;

/**
 * Browser observer with a 200px margin. The margin only extends the root's own box, not the
 * clip of a nested scroller, so a sentinel inside a scrolling pane passes that pane as `root`.
 */
function browserObserverFor(root: Element | null): ObserverFactory | null {
  return typeof IntersectionObserver === 'undefined'
    ? null
    : (callback) => new IntersectionObserver(callback, { root, rootMargin: '200px 0px' });
}
const browserObserver = browserObserverFor(null);

/** Whether `node` lies within `margin` px of `root`'s visible box (the observer's rootMargin). */
export function nearRoot(
  node: { top: number; bottom: number },
  root: { top: number; bottom: number },
  margin = 200,
): boolean {
  return node.bottom >= root.top - margin && node.top <= root.bottom + margin;
}

/**
 * Observes one sentinel node and calls `load` when it intersects. A fresh observer
 * always reports the node's current state first, so re-watching after a page
 * arrives loads the next page when the sentinel is still on screen. With a scrolling
 * `root`, every scroll of it also checks the sentinel's position directly, so any scroll
 * that brings it into range (scrollbar, keys, programmatic jumps) loads even if no
 * intersection change is delivered. One watch loads at most once.
 */
export function watchSentinel(
  node: Element,
  load: () => void,
  create: ObserverFactory | null = browserObserver,
  root: Element | null = null,
): () => void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    load();
  };
  const observer = create?.((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) fire();
  });
  observer?.observe(node);
  const check = () => {
    if (root && nearRoot(node.getBoundingClientRect(), root.getBoundingClientRect())) fire();
  };
  // No synchronous first check: the observer's first report comes after layout settles (for
  // example after the reader pins itself to the end), a check here would see the pre-scroll page.
  root?.addEventListener('scroll', check, { passive: true });
  return () => {
    observer?.disconnect();
    root?.removeEventListener('scroll', check);
  };
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
  root = null,
}: {
  hasNextPage: boolean;
  isFetching: boolean;
  failed: boolean;
  load: () => void;
  /** Scrolling ancestor to observe against (null = viewport). */
  root?: Element | null;
}) {
  const [node, setNode] = useState<Element | null>(null);
  const ref = useCallback((element: Element | null) => setNode(element), []);
  const create = useMemo(() => (root ? browserObserverFor(root) : browserObserver), [root]);
  const enabled = hasNextPage && !isFetching && !failed;
  useEffect(() => {
    if (!node || !enabled) return;
    return watchSentinel(node, load, create, root);
  }, [node, enabled, load, create, root]);
  // Visibility is tracked separately so the fallback appears only at the bottom.
  // Without IntersectionObserver the sentinel counts as visible.
  const [visible, setVisible] = useState(browserObserver === null);
  useEffect(() => {
    if (!node) return;
    return trackSentinel(node, setVisible, create);
  }, [node, create]);
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
