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
 * BOOK-56 — the one fact that decides whether a reader's history exists.
 *
 * It is derived on the server from the changes a reader filed through the interface: a change
 * exists because a reader asked for it, and a filing the operator hid (BOOK-101) counts for
 * nothing. A machine revision (`source_comment IS NULL`) is not a reader's act, so it never
 * turns this flag on. The flag is the gate of the reader-driven apparatus (the authors'
 * series, the discussion, the revision traces); the chronicle itself lists the book's changes
 * whatever caused them — see `HistoryRecordDto`. The DTO is additive; `PROTOCOL_VERSION`
 * stays valid.
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

/**
 * One log row described in full — the machine's own sentence included.
 *
 * No production surface sends this any more: BOOK-65 removed the event list from the REST
 * side and BOOK-102 narrowed the socket to a bare `HistoryEventFrame`. It is kept as the log's
 * own vocabulary — the shape `toHistoryEvent` produces and the log's tests read a row
 * through — and the public record prints `HistoryRecordDto`. Dropping it is a separate ticket.
 */
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
 * Who caused a change: a reader whose filing the book accepted, or a pass over the book
 * (a machine change with no filing behind it, or a landed stage that has no change row).
 */
export type HistoryRecordCause = 'reader' | 'pass';

/**
 * The one door of a reader's change — the record's `правка` section, selected by
 * `?change=<changeId>`. The web's deep link reads the same constant, and a change the page
 * cannot show no longer opens a surface of its own.
 */
export const CHANGE_QUERY_PARAM = 'change';

/** `?change=<id>` — the address a change's row carries and the page reads on load. */
export function changeHref(changeId: string): string {
  return `?${CHANGE_QUERY_PARAM}=${encodeURIComponent(changeId)}`;
}

/**
 * The one door of a pass: `#проход-<changeId>` when the pass carries a change row, and
 * `#проход-<chapter>-<passId>` when it does not (the chapter is part of the key because a bare
 * pass knows its chapter and nothing else can find it). The record behind it parses the same
 * id, so the chronicle row, the foot's door and the page cannot invent different links.
 */
export const PASS_RECORD_PREFIX = 'проход-';

/** The entry id of a pass that has no `changes` row behind it: `pass:<passId>`. */
export function passEntryId(passId: string): string {
  return `pass:${passId}`;
}

/**
 * The one pair a record entry prints as `«было» → «стало»`.
 *
 * A pass takes it from its landed stage (that stage was written next to the text it replaced);
 * a reader's change takes `before` from the words the reader pointed at and `after` from the
 * paragraph the change wrote, and only while that paragraph is still the live text. Where no
 * honest pair exists the entry carries `null` — it never invents a span.
 */
export type HistoryRecordSpan = { before: string; after: string };

/**
 * The public record: **the changes to the book**, whoever caused them, once each.
 *
 * A change is an accepted reader filing or a pass that wrote a chapter. The chronicle used to
 * read only `changes` joined to a visible comment, so a pass that wrote a chapter without a
 * `changes` row (the live book holds 15 `landed` rows for 13 passes, and only four of them
 * carry a change) was missing from the very surface that narrates the book's past. The record
 * is the union of the two sources now: every `changes` row that is not a hidden filing, and
 * every landed pass that carries no change row, one entry per change.
 *
 * `events` still feeds the change card, the diff, the paragraph chain and the authors' series;
 * the `history:event` frame carries no event at all any more (BOOK-102). It appears here only
 * as the moment: `hseq` is the change's last log entry (the pass's last `events.step_id` row),
 * because the scrubber and `GET /api/history/at/:hseq` already speak in `hseq`. There is no
 * `kind`, no cascade and no event summary in this DTO — the public record has no event
 * vocabulary to print.
 */
export type HistoryRecordDto = {
  /**
   * The entry's one identity: the change's id for a change, `pass:<passId>` for a pass that
   * has no change row (`passEntryId`). Two entries are never the same row of the book.
   */
  id: string;
  /** The moment key: the entry's last log row; `0` when a pass left no log row at all. */
  hseq: number;
  /** ISO-8601 UTC of that same moment, display only. Ordering is `hseq`, never this. */
  at: string;
  /** The change's public iteration number — «правка 7»; null for a pass with no change row. */
  seq: number | null;
  /** 1..TOTAL_CHAPTERS: the chapter the change was filed against or the pass wrote. */
  chapter: number;
  /** The chapter's title line at read time; null when the chapter has no title row. */
  chapterTitle: string | null;
  /** BOOK-7: a chapter's premise is not «правка N»; the row's word says so. */
  premise: boolean;
  /**
   * BOOK-7 — the book's own fact about a premise: its chapter has text, so the premise entered
   * the first edition, whatever the attempt behind it went on to say. Derived on the server
   * from the chapter row, the same way the thread and the card read it (`comments/repo.ts`),
   * so the record cannot print «снят» about a chapter that exists. Always `false` for an entry
   * that is not a premise.
   */
  premiseLanded: boolean;
  /**
   * The display name of the reader who filed it, snapshotted on the comment — or `null` for a
   * pass: a machine has no name on the page. The row prints the cause, not the name; the
   * record behind the door prints this where it has one.
   */
  alias: string | null;
  /** Who caused the change: an accepted reader filing, or a pass over the book. */
  cause: HistoryRecordCause;
  /** The change's own state; null for a pass with no change row (it landed, nothing waits). */
  status: ChangeStatus | null;
  outcome: ChangeOutcome | null;
  /** The public one-liner of a refused or stopped change; null otherwise. */
  reason: string | null;
  /**
   * BOOK-168 — the comment the change was filed from. The record's place is a door: the page
   * reads that filing by id and lands on the paragraph it quotes. Declared optional the way a
   * new wire field is (`CommentDto.hint`): the server always sends it, an older row or fixture
   * simply has none, and a reader that does not use it keeps typechecking.
   */
  sourceCommentId?: string | null;
  /** The change behind the entry — the door's key; null for a pass that has no change row. */
  changeId: string | null;
  /**
   * The one way in, built from the same id the record behind the door uses:
   * `?change=<changeId>` for a reader's change, `#проход-<changeId>` for a pass that carries a
   * change row, `#проход-<chapter>-<passId>` for a landed pass that has none.
   */
  recordHref: string;
  /** `«было» → «стало»`; `null` when the book holds no honest pair behind this entry. */
  span: HistoryRecordSpan | null;
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
   * only on an empty log. A started book with no entry yet shows one record — its beginning;
   * every change to the text (a reader's filing, a pass) adds entries beside it.
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

/**
 * The `history:event` frame: **a bare tick** — the log moved, refetch what you show (BOOK-102).
 *
 * The record is the public narration (BOOK-65), and it is read over REST. This frame used to
 * carry the whole `HistoryEventDto` — kind, chapter, rev, cascade, step, author, summary — so
 * every open client received the machine's own sentences even though the SPA only ticked on
 * it. The owner's rule («the reader never sees a step, a wave or a verdict name») now holds on
 * the wire too: the frame says only *when* the clock moved, and the page asks the record what
 * is there to read. `HistoryEventDto` stays as the log's own vocabulary (see its comment); it
 * simply no longer travels on this socket.
 *
 * `PROTOCOL_VERSION` stays 3: the old client read `hseq` from this frame and ignored the rest,
 * so dropping the fields is compatible — no frame it relied on changed shape.
 */
export type HistoryEventFrame = {
  /** The moment key the client ticks on; ordering is the log's, never a clock (§6F.1). */
  hseq: number;
  /** ISO-8601 UTC of that moment, display only — no narrative travels with it. */
  at: string;
};
