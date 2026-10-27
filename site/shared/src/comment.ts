/**
 * Reader comments and the composer (ARCHITECTURE.md §9, §12, §20 M5).
 *
 * A comment is **data**: it is stored as a normalized string, rendered with `textContent`
 * and reaches a model only through a JSON batch (§12.2). Nothing in this file may turn a
 * comment into an instruction, so there is no field that a prompt builder can interpolate
 * into a sentence: every reader-authored value is a separate, bounded string.
 */

import type { CaptchaProvider } from './captcha.ts';
import type { InterventionKind } from './intervention.ts';

/** §12.4 — the bounds that are enforced twice: in the composer and on the server. */
export const COMMENT_MIN_CHARS = 3;
export const COMMENT_MAX_CHARS = 1_200;
export const COMMENT_RAW_MAX_BYTES = 8 * 1024;
export const COMMENT_AUTHOR_MAX_CHARS = 32;
export const COMMENT_QUOTE_MAX_CHARS = 280;
export const COMMENT_AFFIX_MAX_CHARS = 40;
export const COMMENT_REASON_MAX_CHARS = 200;

/**
 * BOOK-DOC-4 rule 1 — a reader's intervention (the proposed wording of a passage) is a
 * different kind of text from a note about it: 10 000 characters, not 1 200. The two caps
 * are deliberately separate constants and are never substituted for one another: widening
 * the note bound would silently widen every comment.
 *
 * Cyrillic costs 2 bytes per character in UTF-8 and a BMP character costs at most 3, so
 * the raw bound covers a full 10 000-character intervention in any script (30 000 B) with
 * headroom — the composer may never promise what the byte guard refuses.
 */
export const EDIT_MIN_CHARS = 3;
export const EDIT_MAX_CHARS = 10_000;
export const EDIT_RAW_MAX_BYTES = 32 * 1024;

/** A typed pair of bounds: text limits travel as one value, never as a bare number. */
export type TextBound = {
  readonly minChars: number;
  readonly maxChars: number;
  readonly maxBytes: number;
};

export const COMMENT_BOUND: TextBound = {
  minChars: COMMENT_MIN_CHARS,
  maxChars: COMMENT_MAX_CHARS,
  maxBytes: COMMENT_RAW_MAX_BYTES,
};

export const EDIT_BOUND: TextBound = {
  minChars: EDIT_MIN_CHARS,
  maxChars: EDIT_MAX_CHARS,
  maxBytes: EDIT_RAW_MAX_BYTES,
};

/**
 * The transport bound for one JSON mutation body, app-wide: a note body plus a full
 * intervention, with JSON and header overhead. It must stay above `EDIT_RAW_MAX_BYTES`, or
 * the transport would refuse what the composer promises; a body past it is still answered
 * with a public `TOO_LONG` rather than a Fastify identifier.
 */
export const REQUEST_BODY_MAX_BYTES = 64 * 1024;

/** §12.3 — the intent is a one-sentence goal, not a copy of the comment. */
export const INTENT_MIN_CHARS = 3;

/**
 * §12.6 — a batch is small on purpose: ≤20 items. One item now carries a note body and a
 * full intervention (up to 30 000 B) plus the anchor, author and flags, so the cap follows
 * the edit bound instead of the old 8 KB note bound.
 */
export const COMMENT_BATCH_MAX_ITEMS = 20;
export const COMMENT_BATCH_ITEM_MAX_BYTES = 40 * 1024;

/** §14 — same identity + body_sha within this window is a duplicate. */
export const COMMENT_DEDUPE_WINDOW_MS = 10 * 60_000;
export const COMMENT_HOUR_MS = 60 * 60_000;
export const EDIT_DAY_MS = 24 * 60 * 60_000;

export type CommentStatus =
  | 'new'
  | 'batched'
  | 'delivered'
  | 'accepted'
  | 'applied'
  | 'superseded'
  | 'rejected'
  | 'quarantined'
  | 'expired'
  | 'hidden';

export type CommentGuard = 'legal' | 'instruction' | 'spam' | 'dup';

/**
 * §12.6, BOOK-9 — the auditor's verdict on an intervention, recorded **before** triage.
 *
 * It is data on the comment row, not a public field: the reader is told the human reason
 * behind a refusal, never the verdict's name (`CommentDto` carries none of this).
 */
export type CommentAuditVerdict = 'FITS' | 'OFF';

/** BOOK-9 — the operator/session label stamped next to a verdict (provenance, not prose). */
export const COMMENT_AUDITED_BY_MAX_CHARS = 64;

/** The anchor is a quote from one revision; `resolved:false` means the quote is gone. */
export type CommentAnchor = {
  blockId: string | null;
  blockIndex: number | null;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  /** False when the quoted block no longer exists in the current chapter revision. */
  resolved: boolean;
};

export type CommentDto = {
  id: string;
  chapter: number;
  anchor: CommentAnchor;
  /** Display name snapshot at posting time; never the Yandex subject (§6C.5). */
  author: string;
  /** Deterministic, so the same reader keeps the same colour across devices. */
  authorColor: string;
  body: string;
  /** A reader's suggested wording; data, never applied verbatim (§6A.2). */
  proposedText: string | null;
  /**
   * BOOK-16 — which of the four world-facts the intervention brings (`document`, `decision`,
   * `testimony`, `erasure`). `null` for a note and for a row stored before BOOK-16; the
   * thread prints the Russian label, never the id.
   */
  interventionKind: InterventionKind | null;
  status: CommentStatus;
  /**
   * BOOK-7 — the intervention became its chapter's premise (the slot was empty when it was
   * accepted). Derived from the linked change, so the thread cannot say «в очереди» about a
   * premise that waits for the chapter's first pass instead.
   */
  premise: boolean;
  /**
   * Public one-liner when the guard stopped it or triage decided (≤200 chars, Russian).
   * The guard's own category and flags stay internal (audit m5): a public `flags` array
   * would let a stranger bisect the detector one probe at a time.
   */
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
  changeId: string | null;
  applied: null | { chapter: number; rev: number };
};

export type CommentPage = {
  items: CommentDto[];
  /** Cursor for the next page (older items); null when the page is not full. */
  nextBefore: string | null;
};

/** What the composer may show about the signed-in reader (§9, §12.8). */
export type ViewerDto = { signedIn: boolean; displayName: string | null };

/** §9 response 201: what is left, so the limit is never a surprise. */
export type CommentBudget = {
  perHour: number;
  remaining: number;
  resetAt: string | null;
  editsPerDay: number;
  editsRemaining: number;
  editsResetAt: string | null;
};

export type PostCommentInput = {
  chapter: number;
  blockId?: string | null;
  quote?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  baseRev?: number | null;
  body: string;
  proposedText?: string | null;
  /**
   * BOOK-16 — the untrusted kind id from the client. Validated inside the service
   * (`validateInterventionKind`), required with `proposedText` and refused without it.
   */
  interventionKind?: string | null;
  captchaToken: string;
  idempotencyKey?: string | null;
};

export type PostCommentResponse = {
  comment: CommentDto;
  remaining: CommentBudget;
  queue: { depth: number };
};

/** §10 `comment:added` — the comment as DATA; the client renders it as text. */
export type CommentAddedPayload = {
  id: string;
  chapter: number;
  anchor: CommentAnchor;
  author: string;
  authorColor: string;
  body: string;
  /** BOOK-16 — the kind word the thread shows beside the decision; `null` for a note. */
  interventionKind: InterventionKind | null;
  /** `new`, `quarantined` or `rejected`: the reader is told the truth immediately. */
  status: CommentStatus;
  reason: string | null;
  createdAt: string;
};

/** §10 `comment:decision` — triage accepted or rejected; acceptance is not application. */
export type CommentDecisionPayload = {
  id: string;
  status: 'accepted' | 'rejected' | 'expired' | 'quarantined';
  reason: string;
  decidedAt: string;
  batchId: string | null;
  changeId: string | null;
  queue: { depth: number; ahead: number };
  source: 'llm';
};

export type FeedbackBatchPayload = {
  batchId: string;
  count: number;
  chapter: number | null;
  createdAt: string;
};

/** The composer's configuration, carried in `hello` so the client fetches nothing extra. */
export type ComposerInfo = {
  captcha: { provider: CaptchaProvider; siteKey: string | null };
  minChars: number;
  /** The note body cap (`COMMENT_MAX_CHARS`): a remark about the prose. */
  maxChars: number;
  /** The intervention cap (`EDIT_MAX_CHARS`): a reader's proposed wording. */
  editMaxChars: number;
};

const AUTHOR_COLORS = ['#6f9bb5', '#a98b6f', '#7d9b6f', '#9b7f9e', '#b58f6f', '#6f8fb5'] as const;

/** Stable colour for a display name: same reader, same ink, no server state. */
export function authorColor(seed: string): string {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length] ?? AUTHOR_COLORS[0];
}

/** Statuses a public thread shows; `hidden` is a moderation state and is never listed. */
export const PUBLIC_COMMENT_STATUSES: readonly CommentStatus[] = [
  'new',
  'batched',
  'delivered',
  'accepted',
  'applied',
  'superseded',
  'rejected',
  'quarantined',
  'expired',
];
