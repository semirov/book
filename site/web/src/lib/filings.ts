import type { CommentDto } from '@book/shared';

import { filingMarginalia } from './marginalia.ts';

/**
 * BOOK-DOC-34 §2.5 — the two persistent marks a filing leaves in the text.
 *
 * A filing is a comment that carries an anchor; it shows as a **cited rule** (the sentence's
 * underline, its shape and ink chosen by state) and a **mark** (the numeral at the sentence's
 * last character). Both are gone the moment the change lands on that paragraph — the revision
 * apparatus takes over — and a filing whose paragraph was rewritten underneath it shows
 * neither: it is stale, and a quiet line in the paragraph says so. States are never colour
 * alone: every ink here travels with the state's own word.
 *
 * The numeral: the schema has no filing sequence, so the mark prints the record's own short
 * suffix (`№A7K` from the ULID). A fabricated ordinal (`№012`) would be a claim about the
 * book's order that no row supports.
 */

export type FilingRule = 'solid' | 'dotted' | 'none';

export type FilingInk = {
  /** The word the surface prints for the state — never colour alone (BOOK-90, one source). */
  word: string;
  rule: FilingRule;
  /** `live` (in the queue or in work), `quiet` (waiting), `stopped` (decided against). */
  tone: 'live' | 'quiet' | 'stopped' | 'done';
};

/**
 * BOOK-90 — the **shape** of a state, never its word: the word comes from `marginalia.ts`,
 * the rule and the ink from this table. A refusal keeps its solid rule and its stopped tone
 * («ждёт», struck through), and the fact that it was refused lives on the second line.
 */
const SHAPES: Record<string, Omit<FilingInk, 'word'>> = {
  new: { rule: 'dotted', tone: 'quiet' },
  batched: { rule: 'solid', tone: 'live' },
  delivered: { rule: 'solid', tone: 'live' },
  accepted: { rule: 'solid', tone: 'live' },
  applied: { rule: 'none', tone: 'done' },
  superseded: { rule: 'solid', tone: 'stopped' },
  rejected: { rule: 'solid', tone: 'stopped' },
  quarantined: { rule: 'solid', tone: 'stopped' },
  expired: { rule: 'solid', tone: 'stopped' },
  hidden: { rule: 'none', tone: 'stopped' },
};

/** State → the ink, the rule shape and the word; unknown states fall to the quiet row. */
export function filingInk(comment: Pick<CommentDto, 'status'> & { premise?: boolean }): FilingInk {
  const shape = SHAPES[comment.status] ?? SHAPES.new!;
  return { word: filingMarginalia(comment).word, ...shape };
}

/** The paragraph's sentence still exists: a stale anchor shows no rule and no mark. */
export function isStale(comment: Pick<CommentDto, 'anchor'>): boolean {
  return !comment.anchor.resolved;
}

/** Pending filings never collapse; a decided one may (it becomes history on apply). */
export function isPending(comment: Pick<CommentDto, 'status'>): boolean {
  return comment.status === 'new' || comment.status === 'batched' || comment.status === 'delivered' || comment.status === 'accepted';
}

/**
 * BOOK-90 — **alive** is what the margin shows at once: everything that still stands on a
 * line of prose, waiting or in work. Held, rejected-but-undecided, expired and quarantined
 * are alive (they wait, they are not history); `applied` is a quiet tick and `hidden` prints
 * nothing anywhere. A filing whose anchor no longer resolves has no line to stand on.
 */
export function isAlive(comment: Pick<CommentDto, 'status' | 'anchor'>): boolean {
  if (isStale(comment)) return false;
  return comment.status !== 'applied' && comment.status !== 'hidden';
}

/** A landed change leaves the 1 px tick: one per sentence, opened on click. */
export function isLanded(comment: Pick<CommentDto, 'status' | 'anchor'>): boolean {
  return comment.status === 'applied' && !isStale(comment);
}

/** Newest first; pending before decided, exactly as the strip lists them. */
export function sortFilings(comments: readonly CommentDto[]): CommentDto[] {
  return [...comments].sort((left, right) => {
    const pending = Number(isPending(right)) - Number(isPending(left));
    if (pending !== 0) return pending;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

/**
 * BOOK-111 — one posted filing at its place in a feed, and never twice.
 *
 * The 201 answer is the row the reader just made; it goes into the chapter's feed at once, so
 * the mark and the strip appear in the same frame instead of after a reload. The feeds are
 * ascending (the server's `listCommentRows` reverses its newest-first page), so the insert
 * keeps that order and a later `refreshComments` — the durable truth — finds the id already
 * there and changes nothing. Returning `null` says the feed already had it, which lets the
 * caller keep the same array and skip a pointless render.
 */
export function insertFiling(comments: readonly CommentDto[], comment: CommentDto): CommentDto[] | null {
  if (comments.some((row) => row.id === comment.id)) return null;
  const at = comments.findIndex((row) => row.createdAt.localeCompare(comment.createdAt) > 0);
  const next = [...comments];
  next.splice(at === -1 ? next.length : at, 0, comment);
  return next;
}

/** `№A7K` — the record's own suffix, stable across reloads and never an invented ordinal. */
export function filingNumber(comment: Pick<CommentDto, 'id'>): string {
  const tail = comment.id.replace(/[^A-Za-z0-9]/gu, '').slice(-3).toUpperCase();
  return `№${tail.length === 3 ? tail : `0${tail}`.slice(-3)}`;
}

export type SentenceFilings = {
  blockId: string;
  quote: string | null;
  /** Pending first, then newest. */
  all: CommentDto[];
  /** The numeral the mark prints: the newest filing's. */
  number: string;
  /** How many more filings share this sentence (`+2` on the mark). */
  extra: number;
  stale: boolean;
};

/** Everything a block carries, grouped by the sentence each filing is anchored to. */
export function filingsForBlock(comments: readonly CommentDto[], blockId: string): SentenceFilings[] {
  const groups = new Map<string, CommentDto[]>();
  for (const comment of comments) {
    if (comment.anchor.blockId !== blockId) continue;
    const key = comment.anchor.quote ?? '';
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return [...groups.entries()].map(([quote, items]) => {
    const all = sortFilings(items);
    return {
      blockId,
      quote: quote.length === 0 ? null : quote,
      all,
      number: filingNumber(all[0] as CommentDto),
      extra: Math.max(0, all.length - 1),
      stale: all.every(isStale),
    };
  });
}

/** The strip shows two rows and one quiet door to the rest (§2.5 overflow). */
export function stripFilings(filings: { all: readonly CommentDto[] }): { shown: CommentDto[]; more: number } {
  const shown = filings.all.slice(0, 2);
  return { shown, more: Math.max(0, filings.all.length - shown.length) };
}

/** `2 замечания · абзац изменился` — a stale anchor's own line in the paragraph. */
export function staleLine(comments: readonly CommentDto[]): string | null {
  const stale = comments.filter(isStale);
  if (stale.length === 0) return null;
  const one = stale.length % 10 === 1 && stale.length % 100 !== 11;
  return `${stale.length} ${one ? 'замечание' : 'замечания'} · абзац изменился`;
}

/** The state word a panel header prints; the same table as the mark, one source. */
export function filingWord(comment: CommentDto): string {
  return filingMarginalia(comment).word;
}

/** The sentence text a filing cites, shortened for a strip row but never re-flowed. */
export function filingQuote(comment: CommentDto, max = 120): string {
  const quote = comment.anchor.quote ?? '';
  const flat = quote.replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return 'абзац изменился';
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
