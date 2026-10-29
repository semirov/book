import type { ChangeSummaryDto, CommentDto } from '@book/shared';

import { changeNumber } from './changeStatus.ts';
import { filingMarginalia, type FilingFacts } from './marginalia.ts';
import { placeHref } from './place.ts';
import type { WordFiling } from './provenance.ts';

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
 * The number: BOOK-218 gives every filing its own public number (`CommentDto.number`, the
 * row's insertion order). A reader reads «замечание 12»; the mark and the note print the bare
 * `12`. No id is ever cut into a number again — an id belongs to the machinery.
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
  // BOOK-137 — a filing on the canon sentence was accepted as paperwork: a solid rule (it is
  // a decided record, not a live queue place) and the done ink, with the word «рассмотрено».
  registered: { rule: 'solid', tone: 'done' },
  superseded: { rule: 'solid', tone: 'stopped' },
  rejected: { rule: 'solid', tone: 'stopped' },
  // BOOK-206 — a filing is never parked for a person any more; a legacy `escalated` row (before
  // the boot migration re-opens it) is a decided-but-unplaced record, so it keeps the quiet ink
  // of an undecided row and no word of its own.
  escalated: { rule: 'solid', tone: 'quiet' },
  quarantined: { rule: 'solid', tone: 'stopped' },
  expired: { rule: 'solid', tone: 'stopped' },
  hidden: { rule: 'none', tone: 'stopped' },
};

/** State → the ink, the rule shape and the word; unknown states fall to the quiet row. */
export function filingInk(comment: FilingFacts): FilingInk {
  return { word: filingMarginalia(comment).word, ...shapeOf(comment) };
}

/**
 * BOOK-219 — the shape follows the **row's own fact**: a receipt on the row means the text is in a
 * chapter, so the row takes the `applied` ink whatever word its status still carries before the
 * durable read replaces it. Every other row reads its status's own row of the table; nothing is
 * re-derived from the linked change here (the server already turned that into the status).
 */
function shapeOf(comment: FilingFacts): Omit<FilingInk, 'word'> {
  if (comment.applied !== null && comment.applied !== undefined) return SHAPES.applied!;
  return SHAPES[comment.status] ?? SHAPES.new!;
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

/**
 * BOOK-158 — a filing that came back different under the same id (a revision replaces the row
 * it revises) keeps its place in the feed. Returns `null` when nothing changed: the very same
 * DTO accepted twice costs no render, which is what makes a posted row idempotent.
 */
export function upsertFiling(comments: readonly CommentDto[], comment: CommentDto): CommentDto[] | null {
  const at = comments.findIndex((row) => row.id === comment.id);
  if (at === -1) return insertFiling(comments, comment);
  if (comments[at] === comment) return null;
  const next = [...comments];
  next[at] = comment;
  return next;
}

/**
 * BOOK-218 — `замечание 12`: the number with the word every card, row and strip prints.
 *
 * The number is the filing's own public one (`CommentDto.number`); the mark and the note print
 * the bare numeral (`filingNum`), because there they stand beside the prose and the word would
 * be a second word. **One noun carries one counter**: a filing is a «замечание», a change is a
 * «правка 012» (`changeNumber`), and no surface prints one under the other's noun.
 */
export function filingNumber(comment: Pick<CommentDto, 'number'>): string {
  return `замечание ${String(comment.number)}`;
}

/** `12` — the bare numeral the mark and the note print. */
export function filingNum(comment: Pick<CommentDto, 'number'>): string {
  return String(comment.number);
}

export type SentenceFilings = {
  blockId: string;
  quote: string | null;
  /** Pending first, then newest. */
  all: CommentDto[];
  /** The numeral the mark prints: the newest filing's, bare (`12`), never a word. */
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
      number: filingNum(all[0] as CommentDto),
      extra: Math.max(0, all.length - 1),
      stale: all.every(isStale),
    };
  });
}

/**
 * BOOK-218 — **one filing is one mark**: the filings of a sentence group that the block has not
 * shown yet. A group can be reached from more than one sentence run (the same wording twice in
 * one paragraph, or a quote whose place resolves twice), and the mark must not repeat: the
 * paragraph showed `12 12` beside one filing. The caller keeps the ids it has drawn for the
 * block; what comes back here is what is still owed a mark and a note.
 */
export function unshownFilings(filings: SentenceFilings, shown: ReadonlySet<string>): CommentDto[] {
  return filings.all.filter((comment) => !shown.has(comment.id));
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

/**
 * BOOK-174 — the `comment:decision` frame, read as the one fact it may add to a filing already
 * on screen: how the filing was read. A decision frame is a broadcast, so it is applied to the
 * row with the same id only — and only when the report it carries is one the row does not have.
 * `refreshComments` remains the durable truth; this keeps the open card from saying «ждёт» for
 * the frame before the reload lands.
 *
 * BOOK-219 — a close that landed the filing's text arrives on the same frame with
 * `status: 'applied'` and the receipt (`applied: { chapter, rev }`); both move the row here, so
 * the record and the text agree in one breath instead of after a reload.
 */
export type CommentDecisionFrame = {
  id: string;
  chapter?: number;
  status?: CommentDto['status'];
  reason?: string;
  decidedAt?: string;
  changeId?: string | null;
  applied?: CommentDto['applied'];
  disposition?: CommentDto['disposition'];
  carrierKind?: CommentDto['carrierKind'];
  /**
   * BOOK-206 audit B1 — the change's next attempt, when the frame says one is scheduled: the
   * time it will be retried at, and the state that attempt is in. Only the fact is applied; the
   * sentence a reader reads is the frame's `reason`, so the page never formats a time of its own.
   */
  attempt?: { state?: string; retryAt?: string | null } | null;
};

/**
 * A filing as the live page holds it: the server's DTO plus the one fact only a frame can bring
 * — a scheduled retry (`retryAt`). The extra field is optional everywhere, so a plain
 * `CommentDto` is still a filing row and the durable refresh replaces the row wholesale.
 */
export type FilingRow = CommentDto & { retryAt?: string | null };

export function decisionFrameOf(data: unknown): CommentDecisionFrame | null {
  if (data === null || typeof data !== 'object') return null;
  const value = data as Partial<CommentDecisionFrame>;
  return typeof value.id === 'string' && value.id.length > 0 ? (value as CommentDecisionFrame) : null;
}

/**
 * BOOK-219 — the chapter a landing frame rewrote, or `null` for every other decision frame.
 *
 * A `comment:decision` about a filing is not news about the prose: triage accepts it long before
 * a chapter moves, and a refusal moves nothing. Only the frame that says `applied` **and**
 * carries the receipt names a chapter whose text the page must read again; the number comes from
 * the server's receipt, never from the frame's own chapter.
 */
export function landingOf(data: unknown): { chapter: number; rev: number } | null {
  if (data === null || typeof data !== 'object') return null;
  const value = data as { status?: unknown; applied?: unknown };
  if (value.status !== 'applied') return null;
  const receipt = value.applied;
  if (receipt === null || typeof receipt !== 'object') return null;
  const { chapter, rev } = receipt as { chapter?: unknown; rev?: unknown };
  if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter <= 0) return null;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return null;
  return { chapter, rev };
}

/** The feed with the frame's report carried onto its own row, or `null` when nothing changed. */
export function withDecisionReport(
  comments: readonly FilingRow[],
  frame: CommentDecisionFrame,
): FilingRow[] | null {
  const at = comments.findIndex((row) => row.id === frame.id);
  if (at < 0) return null;
  const row = comments[at] as FilingRow;
  const next: FilingRow = {
    ...row,
    ...(frame.status === undefined ? {} : { status: frame.status }),
    ...(frame.reason === undefined ? {} : { reason: frame.reason }),
    ...(frame.decidedAt === undefined ? {} : { decidedAt: frame.decidedAt }),
    // A landing names the change it became: the row's link may still point at the attempt that
    // escalated (BOOK-136), and the door must open the change the state now comes from.
    ...(typeof frame.changeId !== 'string' ? {} : { changeId: frame.changeId }),
    ...(frame.applied === undefined ? {} : { applied: frame.applied }),
    ...(frame.disposition === undefined ? {} : { disposition: frame.disposition }),
    ...(frame.carrierKind === undefined ? {} : { carrierKind: frame.carrierKind }),
    // B1 — a scheduled retry (or its absence) is a fact of the row until the durable read says
    // otherwise; the word stays the row's own and the line is the frame's `reason`.
    ...(frame.attempt === undefined ? {} : { retryAt: retryAtOf(frame.attempt) }),
  };
  if (
    next.status === row.status &&
    next.reason === row.reason &&
    next.decidedAt === row.decidedAt &&
    next.changeId === row.changeId &&
    sameApplied(next.applied, row.applied) &&
    (next.disposition ?? null) === (row.disposition ?? null) &&
    (next.carrierKind ?? null) === (row.carrierKind ?? null) &&
    (next.retryAt ?? null) === (row.retryAt ?? null)
  ) {
    return null;
  }
  const out = [...comments];
  out[at] = next;
  return out;
}

/** The retry time a frame names, or `null` when the attempt carries none (a spent one). */
function retryAtOf(attempt: CommentDecisionFrame['attempt']): string | null {
  const at = attempt?.retryAt;
  return typeof at === 'string' && at.length > 0 ? at : null;
}

/** The receipt by value: a frame always carries a fresh object, so identity cannot decide it. */
function sameApplied(left: CommentDto['applied'], right: CommentDto['applied']): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.chapter === right.chapter && left.rev === right.rev;
}

/**
 * BOOK-137 — **one filing is one entry**, and the entry's home is decided here, once.
 *
 * A premise is not a remark about a sentence: it is the chapter's starting point, and its
 * only entry is the chapter's own row (`PremiseRow`, `premiseFiling` in `premise.ts`). The
 * reader's thread therefore lists every filing **except** a premise — the prod page showed
 * the same premise twice, as a comment block and as the chapter's row, with two numbers and
 * two states.
 */
export function threadFilings(comments: readonly CommentDto[]): CommentDto[] {
  return comments.filter((comment) => comment.premise !== true);
}

/** The number an entry prints for a change: `14` → `014` (§DESIGN 7.12). */
export type FilingAttempt = {
  /** The change the entry's «правка →» door opens. */
  id: string;
  /** The attempt's own number (`001`), or null when the page's window does not carry it. */
  number: string | null;
  /**
   * The same attempt as the log's raw sequence (`1`). The filing has its own number now
   * (BOOK-218); this one is the change's, and a caller that prints a change reads it.
   */
  seq: number | null;
};

/**
 * The word's filing as the margin prints it (`lib/provenance.ts`): the filing's own number, the
 * number of the change its latest attempt became, its state word, and its place as a door.
 *
 * BOOK-218 — the filing has a public number of its own, so `number` is that number (`12`) and
 * the provenance prints `правка · 12`: no `№`, no cut id.
 */
export function wordFilingOf(
  comment: CommentDto,
  changes: readonly ChangeSummaryDto[] = [],
): WordFiling {
  return {
    number: filingNum(comment),
    seq: filingAttempt(comment, changes)?.seq ?? null,
    state: filingMarginalia(comment).word,
    href: placeHref(comment),
  };
}

/**
 * BOOK-137 — **an attempt is not a row**: a change is inside the entry of the filing that
 * caused it (`changes.source_comment`), never beside it. `changeId` on the comment is the
 * link the row has always carried; it is the fallback when the loaded window of changes does
 * not reach this filing's attempts (the thread reads the newest page of the lane only).
 *
 * A change with no source comment belongs to the author and the chronicle, and is never a
 * thread entry — that is why the thread's change list is empty by construction.
 */
export function attemptsOf(changes: readonly ChangeSummaryDto[], commentId: string): ChangeSummaryDto[] {
  return changes
    .filter((change) => change.sourceCommentId === commentId)
    .sort((left, right) => left.seq - right.seq);
}

/** The latest attempt — the one number and the one change door an entry carries. */
export function filingAttempt(
  comment: Pick<CommentDto, 'id' | 'changeId'>,
  changes: readonly ChangeSummaryDto[] = [],
): FilingAttempt | null {
  const latest = attemptsOf(changes, comment.id).at(-1);
  if (latest !== undefined) return { id: latest.id, number: changeNumber(latest.seq), seq: latest.seq };
  return comment.changeId === null ? null : { id: comment.changeId, number: null, seq: null };
}

/**
 * The attempts before the latest — the short list inside the filing panel. They keep the
 * entry's one number and one link: a second number on the page would be a second entry.
 */
export function earlierAttempts(
  comment: Pick<CommentDto, 'id'>,
  changes: readonly ChangeSummaryDto[] = [],
): ChangeSummaryDto[] {
  return attemptsOf(changes, comment.id).slice(0, -1);
}

