/**
 * Reader comments and the composer (ARCHITECTURE.md §9, §12, §20 M5).
 *
 * A comment is **data**: it is stored as a normalized string, rendered with `textContent`
 * and reaches a model only through a JSON batch (§12.2). Nothing in this file may turn a
 * comment into an instruction, so there is no field that a prompt builder can interpolate
 * into a sentence: every reader-authored value is a separate, bounded string.
 */

import type { FrameMark } from './frame.ts';
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
 * The transport bound for one JSON mutation body, app-wide: 64 KB — the **envelope** of a
 * request, not a per-field limit. The fields inside it keep their own raw bounds: a note body
 * ≤8 KB (`COMMENT_RAW_MAX_BYTES`), an intervention ≤32 KB (`EDIT_RAW_MAX_BYTES`). The envelope
 * must stay above `EDIT_RAW_MAX_BYTES`, or the transport would refuse what the composer
 * promises; a body past it is still answered with a public `TOO_LONG` rather than a Fastify
 * identifier. A batch item's 40 KB (`COMMENT_BATCH_ITEM_MAX_BYTES`) is a different bound: one
 * line of the exchange file, never one request body.
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
  /**
   * BOOK-137 — the filing touched the frozen frame and was accepted as paperwork: the record
   * exists and the sentence's letters did not change. Never `applied`: nothing was written.
   */
  | 'registered'
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

/**
 * BOOK-61 — which of the three gates refused a filing, or `null` when none did.
 *
 * It is **derived from the stored verdicts** (`status`/`held_rule`, `rights_*`, `audit_*`) and
 * carried to the page on purpose: a reader must be able to tell the three refusals apart by
 * their words («проверяется» · «не принято» · «отклонено»), and no surface may recover that by
 * reading the reason text — a model can write a reason, and a string test is not a verdict.
 */
export type CommentRefusal = 'held' | 'rights' | 'auditor';

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

/**
 * BOOK-158 — where a refused filing stands with respect to another try.
 *
 * It is derived server-side from the attempt ledger (`server/src/comments/attempts.ts`) and
 * travels with every filing: the page must not guess the cooldown, the day's remaining tries or
 * which limit refused, because a guess and the server's answer would disagree the moment the
 * reader reloads in another timezone.
 *
 *   • `allowed` — a revision would be judged now (the row is refused and nothing blocks it);
 *   • `at` — when the refusal's 10-minute cooldown ends (`null` while the row is not refused);
 *   • `attemptsLeft` — of the filing's three tries today;
 *   • `closed` — the day's tries are spent, so the page says «в следующий раз» instead of a
 *     countdown; the tries come back at the next 00:00 UTC, which the refusal that closed them
 *     names as `reopenAt`;
 *   • `blocked` — which limit stands in the way, else `null`.
 */
export type CommentRevise = {
  allowed: boolean;
  at: string | null;
  attemptsLeft: number;
  closed: boolean;
  blocked: 'cooldown' | 'attempts' | 'identity' | 'network' | null;
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
   * BOOK-61 — the gate that refused it: `held` (A), `rights` (B) or `auditor` (C), else `null`.
   * The reader's line is chosen from this field, never from the text of `reason`.
   */
  refusal: CommentRefusal | null;
  /**
   * BOOK-137 — how this filing sat against the frozen frame when it was made: `touched` (it
   * intersects the canon sentence), `adjacent` (its paragraph), `untouched`. `null` for a row
   * stored before v16 — the reader's decision still knows its mark, the old row does not.
   */
  frame: FrameMark | null;
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
   *
   * It is a **sentence or null**, never an internal code (`readerReason` in `change.ts`).
   */
  reason: string | null;
  /**
   * A failed attempt on the linked change, derived once: the change is
   * `void`/`failed`/`escalated` and its reason is an internal code, while the filing itself is
   * not applied. It is **not** a state: the filing keeps its own status and its own word, and
   * the page prints `FAILED_ATTEMPT_LINE` beside it. A landed filing never carries one.
   */
  attempt: 'failed' | null;
  /**
   * BOOK-158 — one actionable line beside a refusal, chosen from the gate that refused it
   * (≤160 chars, Russian). `null` for a filing no gate refused; never generic copy, never a
   * rule id. Declared optional so a page that does not render it yet still typechecks; the
   * server always sends it, and `undefined` reads as `null`.
   */
  hint?: string | null;
  /**
   * BOOK-158 — whether and when this filing may be submitted again. Optional for the same
   * reason as `hint`: the server always sends it, an older page simply ignores it.
   */
  revise?: CommentRevise;
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
  /**
   * BOOK-113 — the operator's own identity may be exempt from the daily edit budget while the
   * owner tests a change. `true` is the only value ever sent; everyone else gets the field
   * omitted, so the ordinary budget keeps its shape. The comment budget still applies.
   */
  editsExempt?: boolean;
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
  /**
   * BOOK-64 — the gate is an authenticated identity plus the rate limits, so a submission
   * carries no token and the field is optional. It stays in the shape only so a challenge
   * can return as its own decision without a second DTO.
   */
  captchaToken?: string | null;
  idempotencyKey?: string | null;
};

export type PostCommentResponse = {
  comment: CommentDto;
  remaining: CommentBudget;
  queue: { depth: number };
};

/**
 * BOOK-158 — `POST /api/comments/:id/revise`. A revision replaces the text of the reader's own
 * retired filing and keeps its place: chapter, anchor, quote and base revision are the original
 * row's and are never sent back by the client, so a revision cannot move to another paragraph.
 */
export type ReviseCommentInput = {
  body: string;
  proposedText?: string | null;
  /** The untrusted kind id; validated inside the service like a new filing's. */
  interventionKind?: string | null;
};

export type ReviseCommentResponse = { comment: CommentDto };

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
  /**
   * BOOK-33 — the chapter the filing belongs to. A decision frame is the only event that
   * can change a mark in the text, and without the chapter the client had to reload the
   * page to stop printing «ждёт рассмотрения» on a decided filing.
   */
  chapter: number;
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

/**
 * The composer's configuration, carried in `hello` so the client fetches nothing extra.
 *
 * BOOK-64: no captcha surface travels here any more — the form submits on identity and the
 * rate limits. A challenge that returns brings its own field with it.
 */
export type ComposerInfo = {
  minChars: number;
  /** The note body cap (`COMMENT_MAX_CHARS`): a remark about the prose. */
  maxChars: number;
  /** The intervention cap (`EDIT_MAX_CHARS`): a reader's proposed wording. */
  editMaxChars: number;
};

/** The fixed ink palette (§11.6): a reader's colour is a slot in it, never a free value. */
export const AUTHOR_COLORS = ['#6f9bb5', '#a98b6f', '#7d9b6f', '#9b7f9e', '#b58f6f', '#6f8fb5'] as const;

/**
 * BOOK-30 — the palette slot a stored colour names; 0 for a row written before the palette,
 * or for a colour this build does not know. The palette is the only authority on ink.
 */
export function authorInkIndex(color: string): number {
  const slot = (AUTHOR_COLORS as readonly string[]).indexOf(color);
  return slot < 0 ? 0 : slot;
}

/**
 * BOOK-30 — the class that carries that ink. The class names the slot, never the hex.
 */
export function authorInkClass(color: string): string {
  return `author-ink-${authorInkIndex(color)}`;
}

/**
 * BOOK-30 — the class for a **stored** colour. The page keeps inline style attributes out
 * of its markup, so the reader's colour is a class: themeable, and no value in the DOM. A
 * colour this build does not know (an older row, another writer) falls back to the reader's
 * own palette slot — derived from the name — rather than collapsing every stranger to slot 0.
 */
export function commentInkClass(author: string, color: string): string {
  const known = (AUTHOR_COLORS as readonly string[]).includes(color);
  return authorInkClass(known ? color : authorColor(author));
}

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
  'registered',
  'superseded',
  'rejected',
  'quarantined',
  'expired',
];
