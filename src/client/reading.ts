import { useCallback, useEffect, useRef, useState } from 'react';

/** Turns loaded when a conversation opens without an anchor. */
export const TAIL_TURNS = 5;
/** Turns added above the window each time the reader reaches the top. */
export const EARLIER_STEP = 10;
/** Pixels from the end that still count as "at the latest turn". */
export const NEAR_END_PX = 160;

/** Where the main fragment stream starts: an anchored turn, the latest turns, or turn 1. */
export type ReadingStart = { kind: 'anchor'; turn: number } | { kind: 'tail' } | { kind: 'top' };

export function initialStart(t: number | undefined): ReadingStart {
  return t === undefined ? { kind: 'tail' } : { kind: 'anchor', turn: t };
}

/**
 * First turn of the main stream (1 = from the beginning). Tail opens at the last TAIL_TURNS
 * turn numbers; the server starts at the first existing turn at or after it (`fromTurn`).
 */
export function mainStart(start: ReadingStart, lastTurnIndex: number | null): number {
  if (start.kind === 'anchor') return start.turn;
  if (start.kind === 'top' || lastTurnIndex === null) return 1;
  return Math.max(1, lastTurnIndex - TAIL_TURNS + 1);
}

/** Start of the next earlier range above `from`, in bounded steps. */
export function earlierStart(from: number): number {
  return Math.max(1, from - EARLIER_STEP);
}

/**
 * Turn ranges [from, until) of the earlier segments, oldest first. `earlier` lists their starts
 * in the order they were added (descending); each ends where the next later range begins.
 */
export function earlierRanges(main: number, earlier: number[]): { from: number; until: number }[] {
  return earlier.map((from, index) => ({ from, until: earlier[index - 1] ?? main })).reverse();
}

/**
 * The turn to hold in place: the first one starting inside the scroller's visible area, else the
 * one spanning its top edge. Only turns qualify: sentinels, loading rows and bars above them are
 * what moves when content is inserted. A turn cut off at the top is a poor anchor when another
 * starts below it: an off-screen turn still drawn at its placeholder height (content-visibility)
 * can be the one that resizes, and its top does not move when it does.
 */
function findAnchor(thread: Element, scroller: Element) {
  const box = scroller.getBoundingClientRect();
  let spanning: { node: Element; top: number } | null = null;
  for (const child of thread.querySelectorAll(':scope > .turn')) {
    const rect = child.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= box.top) continue;
    if (rect.top >= box.top && rect.top < box.bottom) return { node: child, top: rect.top };
    if (rect.top >= box.bottom) break;
    spanning ??= { node: child, top: rect.top };
  }
  return spanning;
}

/**
 * Whether a scroll moved up because the reader moved it: the offset fell by more than a small
 * tolerance while the content did not get shorter. Layout that shrinks content above the view
 * (or clamps at a shorter end) lowers scrollTop together with scrollHeight and does not count.
 */
export function movedUpByReader(
  before: { top: number; height: number },
  now: { scrollTop: number; scrollHeight: number },
): boolean {
  return before.top - now.scrollTop > 48 && now.scrollHeight >= before.height;
}

/** Keys that scroll the reader up (`[` jumps to the previous turn). */
export function upwardScrollKey(event: { key: string; shiftKey: boolean }): boolean {
  return (
    ['PageUp', 'ArrowUp', 'Home', '['].includes(event.key) || (event.key === ' ' && event.shiftKey)
  );
}

/**
 * Keeps the reading position while content changes above it, and optionally pins the view to
 * the end. The thread's first visible child is remembered on every scroll; when the thread
 * resizes (earlier turns inserted, off-screen turns rendered) the scroller is shifted so that
 * child stays where it was. Native `overflow-anchor` stays on: it also corrects in-flight smooth
 * (wheel) scrolls, which a scrollTop write cannot; when it already compensated, the measured
 * shift here is zero, so this only acts where native anchoring is missing or declined.
 *
 * While pinned (after opening at the latest turns or "最新") every resize and scroll returns to
 * the end. Only reader intent unpins: wheel up, an upward scroll key, a pointer press in the pane
 * (scrollbar drag, clicks), or a scroll that moved up while the content did not shrink (Home,
 * dragging, programmatic jumps). Layout alone (late fonts, content-visibility sizes, native
 * anchoring) never unpins, even when it briefly leaves a gap before the next resize callback.
 */
export function useReadingPosition() {
  const [thread, setThread] = useState<HTMLElement | null>(null);
  const ref = useCallback((element: HTMLElement | null) => setThread(element), []);
  const pinned = useRef(false);
  const anchor = useRef<{ node: Element; top: number } | null>(null);
  const [place, setPlace] = useState({ atTop: true, atEnd: true });
  const scroller = useRef<HTMLElement | null>(null);
  const [pane, setPane] = useState<HTMLElement | null>(null);

  const measure = useCallback(
    (capture = true) => {
      const box = scroller.current;
      if (!box || !thread) return;
      if (capture) anchor.current = findAnchor(thread, box);
      const atTop = box.scrollTop <= 4;
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_END_PX;
      setPlace((previous) =>
        previous.atTop === atTop && previous.atEnd === atEnd ? previous : { atTop, atEnd },
      );
    },
    [thread],
  );

  useEffect(() => {
    if (!thread) return;
    const box = thread.closest<HTMLElement>('.reader') ?? thread.parentElement;
    if (!box) return;
    scroller.current = box;
    setPane(box);
    let last = { top: box.scrollTop, height: box.scrollHeight };
    const remember = () => {
      last = { top: box.scrollTop, height: box.scrollHeight };
    };
    const onScroll = () => {
      // Scroll events arrive a frame late. One that only reports our own correction (offset
      // unchanged since then) must not re-pick the anchor: content may have been inserted
      // in between, and the anchor taken before that insertion is the one to hold.
      const moved = Math.abs(box.scrollTop - last.top) >= 1;
      if (pinned.current && movedUpByReader(last, box)) pinned.current = false;
      if (pinned.current && box.scrollHeight - box.scrollTop - box.clientHeight > 1)
        box.scrollTop = box.scrollHeight;
      remember();
      measure(moved);
    };
    const onResize = () => {
      if (pinned.current) box.scrollTop = box.scrollHeight;
      else {
        const saved = anchor.current;
        if (saved?.node.isConnected) {
          const shift = saved.node.getBoundingClientRect().top - saved.top;
          if (Math.abs(shift) >= 1) box.scrollTop += shift;
        }
      }
      remember();
      measure();
    };
    const unpin = () => {
      pinned.current = false;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) unpin();
    };
    const onKey = (event: KeyboardEvent) => {
      if (upwardScrollKey(event)) unpin();
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener('wheel', onWheel, { passive: true });
    // The scrollbar, the thread and the jump controls all live in the pane; "最新" re-pins on click.
    box.addEventListener('pointerdown', unpin);
    window.addEventListener('keydown', onKey);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    observer?.observe(thread);
    measure();
    return () => {
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('pointerdown', unpin);
      window.removeEventListener('keydown', onKey);
      observer?.disconnect();
      scroller.current = null;
      setPane(null);
    };
  }, [thread, measure]);

  /** Scroll to the end and stay there while the latest turns are still arriving. */
  const toEnd = useCallback(() => {
    pinned.current = true;
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
    measure();
  }, [measure]);

  /** Scroll to the very top (conversation header) and stop following the end. */
  const toTop = useCallback(() => {
    pinned.current = false;
    const box = scroller.current;
    if (box) box.scrollTop = 0;
    measure();
  }, [measure]);

  /** Stop following the end without moving (an anchored turn takes over). */
  const release = useCallback(() => {
    pinned.current = false;
  }, []);

  return { ref, scroller: pane, atTop: place.atTop, atEnd: place.atEnd, toEnd, toTop, release };
}
