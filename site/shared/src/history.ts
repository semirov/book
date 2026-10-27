/**
 * The history's wire vocabulary (ARCHITECTURE.md §6F, §11.10).
 *
 * The log is the book's clock: every fact carries a global `hseq`, and every historical
 * view is a projection of the same rows. These types are what the chronicle, the scrubber
 * and the paragraph chain read — never a chapter body, and never a gate finding (§6F.7).
 */

import type { BlockDto } from './types.ts';

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

export type HistoryTimelineDto = {
  /** The book's clock right now — the scrubber's right edge and `bookAt`'s default. */
  lastHseq: number;
  at: string;
  items: HistoryEventDto[];
  /** Cursor for the next page (`before`); null when the page reached the first event. */
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
  costRub: number;
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
