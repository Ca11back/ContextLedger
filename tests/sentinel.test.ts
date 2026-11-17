import { expect, test } from 'bun:test';
import { manualLoadState, type ObserverFactory, watchSentinel } from '../src/client/sentinel';

/** Fake IntersectionObserver: reports the node's current visibility on observe, like the browser. */
function fakeObserver(visible: () => boolean) {
  const live = new Set<(entries: { isIntersecting: boolean }[]) => void>();
  const create: ObserverFactory = (callback) => ({
    observe: () => {
      live.add(callback);
      callback([{ isIntersecting: visible() }]);
    },
    disconnect: () => live.delete(callback),
  });
  const emit = (isIntersecting: boolean) => {
    for (const callback of [...live]) callback([{ isIntersecting }]);
  };
  return { create, emit, live };
}

const node = {} as Element;

test('a sentinel watched after it mounts loads when it is already on screen', () => {
  let visible = true;
  const fake = fakeObserver(() => visible);
  let loads = 0;
  // Mount happens late (detail resolved after fragments): watching starts now and still loads.
  const stop = watchSentinel(node, () => loads++, fake.create);
  expect(loads).toBe(1);
  // Further intersections of the same observer do not load twice for one page.
  fake.emit(true);
  expect(loads).toBe(1);
  stop();
  expect(fake.live.size).toBe(0);
  // After the page arrives the hook re-watches; still visible -> the next page loads.
  const again = watchSentinel(node, () => loads++, fake.create);
  expect(loads).toBe(2);
  again();
  // Pushed off screen by new content: nothing loads until it scrolls back in.
  visible = false;
  const off = watchSentinel(node, () => loads++, fake.create);
  expect(loads).toBe(2);
  fake.emit(true);
  expect(loads).toBe(3);
  off();
});

test('without IntersectionObserver watching is a no-op', () => {
  let loads = 0;
  watchSentinel(node, () => loads++, null)();
  expect(loads).toBe(0);
});

test('the manual fallback appears only when more pages exist and nothing is loading', () => {
  const base = { hasNextPage: true, isFetching: false, failed: false, stalled: false };
  expect(manualLoadState(base)).toBe(false);
  expect(manualLoadState({ ...base, stalled: true })).toBe(true);
  expect(manualLoadState({ ...base, failed: true })).toBe(true);
  expect(manualLoadState({ ...base, stalled: true, isFetching: true })).toBe(false);
  expect(manualLoadState({ ...base, stalled: true, hasNextPage: false })).toBe(false);
});
