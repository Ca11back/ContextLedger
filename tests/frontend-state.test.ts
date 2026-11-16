import { expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/react-query';
import { createDashboardQueryClient } from '../src/client/queries';
import { recordParams, validateDashboardSearch } from '../src/client/search';

test('URL state preserves exact filters and selection but rejects unsafe route parameters', () => {
  const state = validateDashboardSearch({
    request: 'req / 中文',
    model: 'a+b',
    selected: '42',
    view: 'uploads',
    cursor: 99,
    truncated: '1',
    media: 'maybe',
    from: '123',
    to: '456',
  });
  expect(state).toEqual({
    request: 'req / 中文',
    model: 'a+b',
    selected: 42,
    view: 'uploads',
    truncated: '1',
    from: '123',
    to: '456',
  });
  const params = recordParams(state, 25);
  expect(params.get('request')).toBe('req / 中文');
  expect(params.get('cursor')).toBe('25');
  expect(params.has('selected')).toBe(false);
  expect(params.has('view')).toBe(false);
  expect(
    validateDashboardSearch({
      selected: '1e5',
      request: ['x'],
      model: 'a'.repeat(513),
      from: '9007199254740992',
      to: '-1',
      outcome: '<script>',
    }),
  ).toEqual({});
  expect(validateDashboardSearch({ from: '20', to: '10' })).toEqual({});
});

test('request-scoped clients isolate private query data; selection disposal cancels stale work', async () => {
  const first = createDashboardQueryClient(),
    second = createDashboardQueryClient();
  first.setQueryData(['metrics'], { records: 123 });
  expect(second.getQueryData(['metrics'])).toBeUndefined();
  let aborted = false;
  const observer = new QueryObserver(first, {
    queryKey: ['record-view', 1],
    retry: false,
    queryFn: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        setTimeout(() => resolve('old record'), 20);
      }),
  });
  const unsubscribe = observer.subscribe(() => {});
  await first.cancelQueries({ queryKey: ['record-view', 1] });
  first.removeQueries({ queryKey: ['record-view', 1] });
  unsubscribe();
  expect(aborted).toBe(true);
  expect(first.getQueryData(['record-view', 1])).toBeUndefined();
  first.clear();
  second.clear();
});
