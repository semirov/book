/**
 * The extractor's answer as data (BOOK-185, BOOK-DOC-77 §2).
 *
 * The model answers one chapter with one JSON object; this file is the only place its shape is
 * written down. It is `strictObject` on purpose: an extra key is a prompt that drifted, and a
 * schema that silently dropped it would hide the drift until the graph was wrong.
 *
 * `parseAnswer` is the seam between the model's text and the validator. It finds the first `{`
 * and the last `}` (a fenced or prefaced answer is tolerated, because a fence is not a wrong
 * answer), and on failure it returns `SCHEMA_INVALID` with the **zod message** — never with the
 * answer itself. A model answer is a chapter's worth of prose plus a key nobody may print; an
 * error message is what ends up in a transcript and an operator's console.
 *
 * The kind lists live here because three modules share them: the schema (what may be returned),
 * the prompt (what may be asked for) and the validator (what a code can be built from).
 */

import { z } from 'zod';

/** The seven carriers a fact can exist as (BOOK-DOC-77 §2). */
export const FACT_KINDS = ['date', 'document', 'name', 'term', 'promise', 'decision', 'absence'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** The five edges a chapter can assert about earlier facts. */
export const EDGE_KINDS = ['cause', 'promise', 'document', 'absence', 'decision'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** The thread state machine's moves (`ledger/threads.ts`); `closed` is final. */
export const THREAD_EVENT_KINDS = ['opened', 'advanced', 'complicated', 'closed'] as const;
export type ThreadEventKind = (typeof THREAD_EVENT_KINDS)[number];

export const THREAD_DIRECTIONS = ['forward', 'backward'] as const;
export type ThreadDirection = (typeof THREAD_DIRECTIONS)[number];

export function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value);
}

export function isEdgeKind(value: string): value is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(value);
}

export function isThreadEventKind(value: string): value is ThreadEventKind {
  return (THREAD_EVENT_KINDS as readonly string[]).includes(value);
}

/** A local ref (`f1`) the model uses to name a fact it returns; never a DB id. */
const refSchema = z.string().min(1).max(40);
/** A key of a fact the book already holds (`document:65-11877-арх`). */
const keyRefSchema = z.strictObject({ key: z.string().min(1).max(300) });
const endpointSchema = z.union([refSchema, keyRefSchema]);

const factSchema = z.strictObject({
  ref: refSchema.optional(),
  kind: z.enum(FACT_KINDS),
  value: z.string().min(1).max(400),
  term: z.string().min(1).max(400).optional(),
  quote: z.string().min(1).max(2000),
  sentence: z.string().min(1).max(2000).optional(),
});

const useSchema = z.strictObject({
  kind: z.enum(FACT_KINDS),
  value: z.string().min(1).max(400),
  quote: z.string().min(1).max(2000),
  sentence: z.string().min(1).max(2000).optional(),
});

const edgeSchema = z.strictObject({
  from: endpointSchema,
  to: endpointSchema,
  kind: z.enum(EDGE_KINDS),
  quote: z.string().min(1).max(2000),
  statement: z.string().min(1).max(2000).optional(),
});

const threadEventSchema = z.strictObject({
  /** Ignored by the validator: the chapter under extraction is the only stamp (`validate.ts`). */
  chapter: z.number().int().optional(),
  kind: z.enum(THREAD_EVENT_KINDS),
  fact: refSchema.optional(),
  note: z.string().min(1).max(2000).optional(),
  quote: z.string().min(1).max(2000).optional(),
});

const threadSchema = z.strictObject({
  label: z.string().min(1).max(300),
  direction: z.enum(THREAD_DIRECTIONS).optional(),
  events: z.array(threadEventSchema).max(50),
});

/**
 * An empty array is a legitimate answer (BOOK-DOC-77 §2, section 7): a chapter of pure scene has
 * no carrier, and a prompt that punished silence would buy invented facts. `.default([])` means a
 * missing key reads as that silence instead of as a schema failure — the four keys are the
 * contract, and a model that omitted an empty one did not break it.
 */
export const answerSchema = z.strictObject({
  facts: z.array(factSchema).max(400).default([]),
  uses: z.array(useSchema).max(400).default([]),
  edges: z.array(edgeSchema).max(200).default([]),
  threads: z.array(threadSchema).max(50).default([]),
});

export type GraphAnswer = z.infer<typeof answerSchema>;

/** The answer as the model may return it, before a kind is known to be one of the lists. */
export type LooseAnswer = {
  facts: Array<{
    ref?: string;
    kind: string;
    value: string;
    term?: string;
    quote: string;
    sentence?: string;
  }>;
  uses: Array<{ kind: string; value: string; quote: string; sentence?: string }>;
  edges: Array<{
    from: string | { key: string };
    to: string | { key: string };
    kind: string;
    quote: string;
    statement?: string;
  }>;
  threads: Array<{
    label: string;
    direction?: string;
    events: Array<{ chapter?: number; kind: string; fact?: string; note?: string; quote?: string }>;
  }>;
};

/**
 * The code was written for the transcript: a reader must be able to tell a schema failure from a
 * transport failure without reading the answer. There is one code, because every way the text
 * fails to be the object is the same repair: ask again, then fail the run.
 */
export const SCHEMA_INVALID = 'SCHEMA_INVALID';

/** How much of a zod message an error keeps. A message names paths and rules, never values. */
const MESSAGE_LIMIT = 400;

export type ParseResult = { ok: true; answer: GraphAnswer } | { ok: false; error: string; json?: unknown };

function invalid(detail: string, json?: unknown): ParseResult {
  const message = detail.length > MESSAGE_LIMIT ? `${detail.slice(0, MESSAGE_LIMIT - 1)}…` : detail;
  return json === undefined
    ? { ok: false, error: `${SCHEMA_INVALID}: ${message}` }
    : { ok: false, error: `${SCHEMA_INVALID}: ${message}`, json };
}

/**
 * Parse the model's answer. Fences and prose around the object are stripped by taking the first
 * `{` to the last `}` — a model that wraps the object in ```json is answering, not disobeying —
 * but nothing inside the object is repaired: the schema is the contract.
 */
export function parseAnswer(text: string): ParseResult {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from === -1 || to <= from) return invalid('the answer contains no JSON object');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(from, to + 1)) as unknown;
  } catch {
    // The parser's own message names a position, never the text.
    return invalid('the answer is not valid JSON');
  }

  const result = answerSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length === 0 ? 'answer' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return invalid(details, parsed);
  }
  return { ok: true, answer: result.data };
}
