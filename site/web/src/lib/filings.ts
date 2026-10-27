import type { CommentDto } from '@book/shared';

import { commentStatusLine } from './commentView.ts';

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
  /** The word the surface prints for the state — never colour alone. */
  word: string;
  rule: FilingRule;
  /** `live` (in the queue or in work), `quiet` (waiting), `stopped` (decided against). */
  tone: 'live' | 'quiet' | 'stopped' | 'done';
};

const RULES: Record<string, FilingInk> = {
  new: { word: 'ждёт рассмотрения', rule: 'dotted', tone: 'quiet' },
  batched: { word: 'в проходе триажа', rule: 'solid', tone: 'live' },
  delivered: { word: 'в проходе триажа', rule: 'solid', tone: 'live' },
  accepted: { word: 'в очереди', rule: 'solid', tone: 'live' },
  applied: { word: 'внесено', rule: 'none', tone: 'done' },
  superseded: { word: 'снято', rule: 'solid', tone: 'stopped' },
  rejected: { word: 'отклонено', rule: 'solid', tone: 'stopped' },
  quarantined: { word: 'проверяется', rule: 'solid', tone: 'stopped' },
  expired: { word: 'не рассмотрено', rule: 'solid', tone: 'stopped' },
  hidden: { word: 'скрыто', rule: 'none', tone: 'stopped' },
};

/** State → the ink, the rule shape and the word; unknown states fall to the quiet row. */
export function filingInk(comment: Pick<CommentDto, 'status'>): FilingInk {
  return RULES[comment.status] ?? RULES.new!;
}

/** The paragraph's sentence still exists: a stale anchor shows no rule and no mark. */
export function isStale(comment: Pick<CommentDto, 'anchor'>): boolean {
  return !comment.anchor.resolved;
}

/** Pending filings never collapse; a decided one may (it becomes history on apply). */
export function isPending(comment: Pick<CommentDto, 'status'>): boolean {
  return comment.status === 'new' || comment.status === 'batched' || comment.status === 'delivered' || comment.status === 'accepted';
}

/** Newest first; pending before decided, exactly as the strip lists them. */
export function sortFilings(comments: readonly CommentDto[]): CommentDto[] {
  return [...comments].sort((left, right) => {
    const pending = Number(isPending(right)) - Number(isPending(left));
    if (pending !== 0) return pending;
    return right.createdAt.localeCompare(left.createdAt);
  });
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
export function stripFilings(filings: SentenceFilings): { shown: CommentDto[]; more: number } {
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
  return commentStatusLine(comment).state;
}

/** The sentence text a filing cites, shortened for a strip row but never re-flowed. */
export function filingQuote(comment: CommentDto, max = 120): string {
  const quote = comment.anchor.quote ?? '';
  const flat = quote.replace(/\s+/gu, ' ').trim();
  if (flat.length === 0) return 'абзац изменился';
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
