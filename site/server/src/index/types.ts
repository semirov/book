/**
 * The derived index (BOOK-18) — a light reading of the prose, never canon.
 *
 * The index is computed from `manuscript/`, is keyed by the manuscript's hash, and is
 * replaced wholesale by a rebuild. It is never a source of truth for prose, never a plot
 * plan, and is never edited by hand: its only jobs are to give the editor a bounded slice to
 * check causality against, and to let the chronicle say one plain sentence about a
 * document's status.
 *
 * **Erring by design.** No build fails because the index is unsure, no gate fails on an
 * index mismatch, and an ambiguous entity is recorded (`ambiguous: true`) rather than
 * raised as an error. The reader of a slice is the editor; the editor knows it may err.
 */

/** Bumping this invalidates every stored artifact (the hash includes it). */
export const INDEX_VERSION = 1;

/** One chapter's neighbours and itself — the most a slice ever holds. */
export const SLICE_RADIUS = 1;

export type EntityKind = 'person' | 'place' | 'organisation' | 'unknown';

/** The four ways a paper can act in a chapter (BOOK-18 §1). */
export type DocumentStatus = 'issued' | 'annulled' | 'amended' | 'quoted';

export type EntityMention = {
  /** 0-based paragraph index inside the chapter. */
  paragraph: number;
  /** The surface form as found in the text. */
  surface: string;
};

export type IndexedEntity = {
  /** Lowercase, ё→е, spaces collapsed: a heuristic key, not an identity. */
  key: string;
  kind: EntityKind;
  /** Every surface form found for this key, sorted. */
  surfaces: string[];
  mentions: EntityMention[];
  /**
   * The key was also seen as a lowercase word, or two surfaces collapse into one key.
   * Recorded, never fatal: the editor decides whether it is one entity or two.
   */
  ambiguous: boolean;
};

export type IndexedPromise = {
  paragraph: number;
  /** The promise marker as found («обещал», «должна», …), lowercase. */
  marker: string;
  /** The sentence, bounded to 200 characters. */
  text: string;
};

export type TimeMarkerKind = 'year' | 'month' | 'relative' | 'season' | 'daypart';

export type TimeMarker = {
  paragraph: number;
  kind: TimeMarkerKind;
  text: string;
};

export type DocumentReference = {
  /** Lowercase key: the paper's noun plus its number or quoted name, if one follows. */
  document: string;
  /** The surface as found, e.g. «Приказ № 4». */
  surface: string;
  /** The last status found in reading order — what the chapter's text says now. */
  status: DocumentStatus;
  /** Every paragraph the status was found in, sorted. */
  paragraphs: number[];
};

/**
 * One chapter's slice of the index. A slot holding only its basis sentence (ch01/ch42) or
 * nothing is `written: false` and carries empty collections: the frozen frame is not prose
 * to index (BOOK-6).
 */
export type ChapterIndex = {
  n: number;
  written: boolean;
  /** The chapter's normalized text hash, the same one the projection stores. */
  sha256: string;
  entities: IndexedEntity[];
  promises: IndexedPromise[];
  timeMarkers: TimeMarker[];
  documents: DocumentReference[];
};

/** The whole artifact. No timestamps: identical input gives identical bytes. */
export type DerivedIndex = {
  version: number;
  /** `sha256` over the version and every chapter's `n:sha256`, sorted by `n`. */
  manuscriptHash: string;
  chapters: ChapterIndex[];
};

/** What an editor assignment points at: one chapter and its neighbours, never the book. */
export type IndexSlice = {
  version: number;
  manuscriptHash: string;
  chapter: number;
  chapters: ChapterIndex[];
};
