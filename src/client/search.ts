// URL state for the single-screen UI. Everything the user can share or refresh lives here.
// `zod/mini` (functional API, same Zod 4 Standard Schema) keeps the client bundle ~60 kB smaller
// than classic `zod`; `z.catch(...)` is the mini form of `.catch()`.
import * as z from 'zod/mini';

export const filterKeys = ['user', 'token', 'model', 'status', 'kind', 'from', 'to'] as const;
export type FilterKey = (typeof filterKeys)[number];
export const statusValues = ['error', 'partial', 'media'] as const;
export const kindValues = ['main', 'subagent'] as const;

/** URL values arrive as strings or (JSON-parsed) numbers; compare them as written. */
const written = z.pipe(z.union([z.string(), z.number()]), z.transform(String));

/** Positive safe integer written with at most 15 digits (string or number in the URL). */
const positive = z.catch(
  z.optional(
    z.pipe(
      z.pipe(written, z.string().check(z.regex(/^\d{1,15}$/))),
      z.pipe(z.transform(Number), z.int().check(z.positive())),
    ),
  ),
  undefined,
);

/** Free-text filter: a string of 1–256 characters. */
const text = z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined);

const fields = z.object({
  tab: z.catch(z.optional(z.literal('requests')), undefined),
  /** Open conversation. */
  c: positive,
  /** Anchored turn inside the open conversation. */
  t: positive,
  /** Open single request (requests without a conversation). */
  r: positive,
  user: text,
  token: text,
  model: text,
  status: z.catch(z.optional(z.enum(statusValues)), undefined),
  kind: z.catch(z.optional(z.enum(kindValues)), undefined),
  from: positive,
  to: positive,
});

type Fields = z.output<typeof fields>;

/**
 * Route search schema (Zod 4 mini, passed directly to `validateSearch`). Invalid values fall back to
 * absent; unknown keys are dropped; an inverted time range drops both ends; a turn without a
 * conversation is dropped.
 */
export const appSearchSchema = z.pipe(
  fields,
  z.transform((input: Fields): Fields => {
    const result: Fields = {};
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) Object.assign(result, { [key]: value });
    if (result.from !== undefined && result.to !== undefined && result.from > result.to) {
      delete result.from;
      delete result.to;
    }
    if (result.c === undefined) delete result.t;
    return result;
  }),
);

export type AppSearch = z.output<typeof appSearchSchema>;

export function validateAppSearch(input: Record<string, unknown>): AppSearch {
  return appSearchSchema.parse(input);
}

export function hasFilters(search: AppSearch): boolean {
  return filterKeys.some((key) => search[key] !== undefined);
}

export function listParams(
  search: AppSearch,
  cursor: string | null | undefined,
  keys: readonly FilterKey[],
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = search[key];
    if (value !== undefined) params.set(key, String(value));
  }
  if (cursor) params.set('cursor', cursor);
  return params;
}

export const conversationFilterKeys = filterKeys;
export const requestFilterKeys = ['user', 'token', 'model', 'status', 'from', 'to'] as const;
