/**
 * The history's wire vocabulary (ARCHITECTURE.md §6F, §11.10).
 *
 * The log is the book's clock: every fact carries a global `hseq`, and every historical
 * view is a projection of the same rows. These types are what the chronicle, the scrubber
 * and the paragraph chain read — never a chapter body, and never a gate finding (§6F.7).
 */

import type { ChangeOutcome, ChangeStatus } from './change.ts';
import type { BlockDto } from './types.ts';

/**
 * BOOK-56 — the one fact that decides whether the book has a past to show.
 *
 * It is derived on the server from `changes.source_comment IS NOT NULL`: a change exists
 * because a reader filed it. A machine revision (`source_comment IS NULL`) is not a
 * reader's history, and the first reader change turns every history surface on with no
 * code change and no deploy. The DTO is additive; `PROTOCOL_VERSION` stays valid.
 */
export type HistoryStateDto = {
  /** True once the log holds at least one change caused by a reader's filing. */
  live: boolean;
  /** The count it was derived from; public, and never a per-reader number. */
  readerChanges: number;
  /**
   * The log holds its first record, so the chronicle exists from the book's start — one
   * record, «начало книги». The rest of the apparatus still waits for a reader change, so
   * this is implied by, and never a replacement for, `live`.
   */
  started: boolean;
};

export type HistoryKind =
  | 'chapter.created'
  | 'chapter.revised'
  | 'chapter.restored'
  | 'front.revised'
  | 'change.queued'
  | 'change.processing'
  | 'change.stale'
  | 'change.decided'
  | 'cascade.opened'
  | 'cascade.closed'
  | 'step.opened'
  | 'step.landed'
  | 'step.closed'
  | 'gate.recorded'
  /** BOOK-18: one public statement about a document's status, from the derived index. */
  | 'document.status'
  | 'overwrite'
  | 'operator.restore'
  | 'operator.release'
  | 'operator.hide';

export type HistoryAuthorKind = 'reader' | 'author' | 'writer' | 'operator' | 'unattributed';

/** The SPEC's chain, resolved: reader → change → text, with the display name snapshotted. */
export type HistoryAuthor = {
  kind: HistoryAuthorKind;
  identityId: string | null;
  label: string;
};

export type HistoryEventDto = {
  hseq: number;
  /** ISO-8601 UTC, display only. Ordering is `hseq`, never this (§6F.1 rule 2). */
  at: string;
  kind: HistoryKind;
  chapter: number | null;
  isFront: boolean;
  rev: number | null;
  changeId: string | null;
  cascadeId: string | null;
  stepId: string | null;
  author: HistoryAuthor;
  /** One Russian line: «глава 9 переписана правкой 7 (Аня)» (§11.10). */
  summary: string;
};

/**
 * The public record: **one change a person made through the interface**, once (BOOK-65).
 *
 * The chronicle is no longer a projection of the log. Every event — a front revision, a gate
 * dispatch, a wave, a lease, a join, a hide — is the machinery talking, and printing it turned
 * the bookkeeping into a public line. A record reads the `changes` table instead, joined to
 * the comment a reader filed: a change exists because a person asked for it, so one change is
 * exactly one entry, and a machine-only pass has nothing to show.
 *
 * `events` still feeds the change card, the diff, the paragraph chain, the authors' series and
 * the `history:event` frame. It appears here only as the moment: `hseq` is the change's last
 * log entry, because the scrubber and `GET /api/history/at/:hseq` already speak in `hseq`.
 * There is no `kind`, no cascade, no step and no event summary in this DTO — the public record
 * must have no event vocabulary to print.
 */
export type HistoryRecordDto = {
  /** The moment key: the `hseq` of the change's last log entry. */
  hseq: number;
  /** ISO-8601 UTC of that same entry, display only. Ordering is `hseq`, never this. */
  at: string;
  /** The change's public iteration number — «правка 7». */
  seq: number;
  /** 1..67: the chapter the change was filed against. */
  chapter: number;
  /** BOOK-7: a chapter's premise is not «правка N»; the row's word says so. */
  premise: boolean;
  /**
   * BOOK-7 — the book's own fact about a premise: its chapter has text, so the premise entered
   * the first edition, whatever the attempt behind it went on to say. Derived on the server
   * from the chapter row, the same way the thread and the card read it (`comments/repo.ts`),
   * so the record cannot print «снят» about a chapter that exists. Always `false` for a
   * change that is not a premise.
   */
  premiseLanded: boolean;
  /** The display name of the reader who filed it, snapshotted on the comment. */
  alias: string;
  status: ChangeStatus;
  outcome: ChangeOutcome | null;
  /** The public one-liner of a refused or stopped change; null otherwise. */
  reason: string | null;
  /** The one way in: the change card. */
  changeId: string;
};

export type HistoryTimelineDto = {
  /** The book's clock right now — the scrubber's right edge and `bookAt`'s default. */
  lastHseq: number;
  /**
   * The logged moment of `lastHseq` (BOOK-65): the rest position prints this, or the newest
   * record when the log holds no row. It is the log's own last instant, never the browser
   * clock — BOOK-DOC-48 refused a clock, not a logged moment.
   */
  lastAt: string | null;
  /**
   * The book's first logged moment: the starting record's date (`начало книги`), or `null`
   * only on an empty log. A started book shows one record — its beginning — before any reader
   * has changed the text; the first reader change adds the changes themselves.
   */
  firstAt: string | null;
  at: string;
  items: HistoryRecordDto[];
  /** Cursor for the next page (`before`); null when the page reached the oldest record. */
  nextBefore: number | null;
};

export type BookAtChapterDto = {
  n: number;
  /** 0 = the chapter did not exist at that moment; absence is shown as absence (§6F.2). */
  rev: number;
  written: boolean;
  title: string | null;
  chars: number;
};

export type BookAtDto = {
  hseq: number;
  /** The moment the last event at or before `hseq` happened; null before the first event. */
  at: string | null;
  front: { rev: number; title: string | null; about: string | null } | null;
  chapters: BookAtChapterDto[];
  lastHseq: number;
};

export type HistoryChapterDto = {
  n: number;
  hseq: number;
  at: string;
  rev: number;
  title: string | null;
  chars: number;
  blocks: BlockDto[];
  cause: { kind: string; changeId: string | null; cascadeId: string | null; stepId: string | null } | null;
};

export type ParagraphVersionDto = {
  blockUid: string;
  ver: number;
  /** The content-derived id at that version (`ch08#aa11bb22`). */
  blockId: string;
  chapter: number;
  rev: number;
  at: string;
  op: 'introduced' | 'revised' | 'kept' | 'erased';
  textHash: string;
  chars: number;
  changeId: string | null;
  /**
   * The change's public number — «правка 014» (BOOK-59). The panel speaks in numbers; an id
   * never reaches a reader. Null when the version came from outside the process.
   */
  changeSeq: number | null;
  stepId: string | null;
  actor: HistoryAuthor | null;
  /** The uid that took this paragraph's place, when the version was replaced. */
  replacedBy: string | null;
};

/** `GET /api/history/paragraphs/:blockId` — one paragraph's chain through every rewrite. */
export type ParagraphChainDto = {
  blockUid: string;
  blockId: string;
  chapter: number;
  /** Still in the text at the last hseq. The chain ends there, or at an erasure. */
  alive: boolean;
  versions: ParagraphVersionDto[];
  /** «переписано в 14:20 правкой 7 · было: правка 3 (Аня)». */
  line: string;
};

export type HistoryDiffOpDto = {
  op: 'added' | 'removed' | 'replaced';
  chapter: number;
  blockId: string;
  replacedBy: string | null;
  textHash: string;
  at: string | null;
  changeId: string | null;
};

export type HistoryDiffDto = {
  from: number;
  to: number;
  ops: HistoryDiffOpDto[];
  /** The span held more than the 500-op ceiling; the client pages with a narrower range. */
  truncated: boolean;
};

export type ChangeImpactDto = {
  changeId: string;
  chaptersTouched: number[];
  chaptersRewritten: number[];
  blocksChanged: number;
  charsAdded: number;
  charsRemoved: number;
  overwrites: number;
  seams: Array<{ boundary: number | 'front' | 'ending'; resolved: boolean }>;
  depth: { down: number; up: number };
  tokens: number;
  /**
   * The money the change actually spent, or `null` when it was never measured (BOOK-23).
   * A zero here would be a placeholder dressed as a measurement, so it stays absent.
   */
  costRub: number | null;
  ms: number;
  history: { fromHseq: number; toHseq: number };
  computedAt: string;
};

export type ContributorPointDto = {
  day: string;
  edits: number;
  chars: number;
  share: number;
};

export type ContributorDto = {
  /** A public alias — `sha256(identityId)` truncated, never the identity key (audit m3). */
  identityId: string;
  label: string;
  edits: number;
  chars: number;
  share: number;
};

export type ContributorsDto = {
  totalChars: number;
  measuredAt: string | null;
  items: ContributorDto[];
};

/** The `history:event` frame: one tick of the chronicle, no bodies (§10.3, §6F.1). */
export type HistoryEventFrame = HistoryEventDto;
