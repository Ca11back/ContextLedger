import type { AdapterResult } from './common';

/** Alpha search has no chat output: its complete JSON response is the terminal evidence. */
export function alphaSearch(response: Record<string, unknown>): AdapterResult {
  const body = response.body;
  return {
    input: [],
    output: [],
    terminal:
      response.stream === false &&
      typeof response.status === 'number' &&
      Number.isInteger(response.status) &&
      response.status >= 200 &&
      response.status < 300 &&
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body),
  };
}
