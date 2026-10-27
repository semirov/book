import type { InterventionKind } from '@book/shared';

import { formatChars } from './format.ts';
import { splitSentences } from './seam.ts';

/**
 * BOOK-DOC-34 §2.1, §2.3 — the draft.
 *
 * Closing the seam is not cancelling the thought: the draft stays in memory, keyed by the
 * seam it belongs to, and reopening that seam shows `черновик · 43 знака` in the provenance
 * line. Nothing here ever sends or drops a draft in the background.
 *
 * «что это меняет» is optional, and an empty field is not an empty filing: the first sentence
 * of «как это звучит в книге» becomes the body, and the form says so **before** submit. That
 * derivation is a pure function so the copy can be tested without a browser.
 */

export type SeamDraft = {
  chapter: number;
  /** No block on an empty chapter: the premise carries the chapter only. */
  blockId: string | null;
  /**
   * The chapter revision the paragraph was rendered from — the base the server checks the
   * anchor against (BOOK-33). It is captured when the seam opens, not read from the catalog
   * at submit time: a revision that arrived while the reader was writing is exactly what
   * `STALE_ANCHOR` must catch, and the re-anchor path then works on the new text.
   */
  baseRev: number | null;
  /** The paragraph's index in the chapter, so a re-anchor can find its new place by position. */
  blockIndex: number | null;
  /** The sentence the seam is on; for a premise, the chapter's own label. */
  sentence: string;
  kind: InterventionKind | null;
  /** The note path: no kind is sent, and «как это звучит» is not asked for. */
  noteOnly: boolean;
  body: string;
  proposed: string;
};

export type DraftOrigin = {
  chapter: number;
  blockId: string | null;
  sentence: string;
  baseRev: number | null;
  blockIndex?: number | null;
  noteOnly?: boolean;
};

export function emptyDraft(origin: DraftOrigin): SeamDraft {
  return {
    chapter: origin.chapter,
    blockId: origin.blockId,
    baseRev: origin.baseRev,
    blockIndex: origin.blockIndex ?? null,
    sentence: origin.sentence,
    kind: null,
    noteOnly: origin.noteOnly ?? false,
    body: '',
    proposed: '',
  };
}

/**
 * A draft store that lives for the page session and no longer: a Map, keyed by the seam.
 * `keep` returns the same store so a caller can chain it; nothing is ever queued for sending.
 */
export type DraftStore = {
  keep(key: string, draft: SeamDraft): void;
  read(key: string): SeamDraft | null;
  drop(key: string): void;
  size(): number;
};

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, SeamDraft>();
  return {
    keep(key, draft) {
      drafts.set(key, draft);
    },
    read(key) {
      return drafts.get(key) ?? null;
    },
    drop(key) {
      drafts.delete(key);
    },
    size() {
      return drafts.size;
    },
  };
}

/** The page's one store: components reopen a seam and find their draft where they left it. */
export const seamDrafts: DraftStore = createDraftStore();

/**
 * BOOK-33 — re-key a draft onto a fresh anchor without touching what the reader wrote.
 *
 * A stale anchor means the paragraph moved: the draft keeps its `body`/`proposed`/`kind` and
 * takes the new block, sentence and revision, so the next send is anchored at the text that
 * exists now instead of failing on the revision that is gone.
 */
export function rekeyDraft(
  draft: SeamDraft,
  anchor: { blockId: string; sentence: string; baseRev: number; blockIndex?: number | null },
): SeamDraft {
  return {
    ...draft,
    blockId: anchor.blockId,
    sentence: anchor.sentence,
    baseRev: anchor.baseRev,
    blockIndex: anchor.blockIndex ?? draft.blockIndex,
  };
}

/** The anchored request body the form sends; one shape, so a re-keyed draft is proven to travel. */
export function anchoredPayload(
  draft: Pick<SeamDraft, 'chapter' | 'blockId' | 'baseRev' | 'sentence'>,
  input: { body: string; captchaToken: string; proposedText?: string | null; interventionKind?: string | null },
): {
  chapter: number;
  blockId: string | null;
  quote: string | null;
  baseRev: number | null;
  body: string;
  proposedText?: string | null;
  interventionKind?: string | null;
  captchaToken: string;
} {
  return {
    chapter: draft.chapter,
    blockId: draft.blockId,
    quote: draft.blockId === null ? null : draft.sentence,
    baseRev: draft.blockId === null ? null : draft.baseRev,
    body: input.body,
    ...(input.proposedText === undefined ? {} : { proposedText: input.proposedText }),
    ...(input.interventionKind === undefined ? {} : { interventionKind: input.interventionKind }),
    captchaToken: input.captchaToken,
  };
}

/** The first sentence of the proposed wording — never the whole field. */
export function firstSentenceOf(text: string): string {
  const [sentence] = splitSentences(text);
  return sentence?.text ?? text.replace(/\s+/gu, ' ').trim();
}

/** What is sent as `body`: the reader's line, or the first sentence of the wording below it. */
export function derivedBody(draft: Pick<SeamDraft, 'body' | 'proposed' | 'noteOnly'>): string {
  const body = draft.body.replace(/\s+/gu, ' ').trim();
  if (body.length > 0) return body;
  return draft.noteOnly ? '' : firstSentenceOf(draft.proposed);
}

/**
 * What is sent as `body`, per the kind of filing (BOOK-33).
 *
 * An intervention may derive its body from the wording's first sentence; a **premise** and a
 * note are one text and are sent whole — deriving a premise's body cut a multi-sentence
 * premise after its first full stop, silently.
 */
export function submissionBody(draft: Pick<SeamDraft, 'body' | 'proposed' | 'noteOnly' | 'blockId'>): string {
  if (draft.noteOnly || draft.blockId === null) {
    return draft.proposed.replace(/\s+/gu, ' ').trim() || draft.body.replace(/\s+/gu, ' ').trim();
  }
  return derivedBody(draft);
}

/** `черновик · 43 знака` — the line the reopened strip prints; null for a clean draft. */
export function draftSummary(draft: Pick<SeamDraft, 'body' | 'proposed' | 'kind' | 'noteOnly'>): string | null {
  const body = derivedBody(draft);
  const authored = body.length > 0 || draft.proposed.trim().length > 0 || draft.kind !== null;
  if (!authored) return null;
  return `черновик · ${formatChars(body.length)}`;
}

/** Does this draft have anything worth sending? (A kind alone is not a filing.) */
export function draftFilled(draft: Pick<SeamDraft, 'body' | 'proposed' | 'noteOnly'>): boolean {
  const body = derivedBody(draft);
  return body.length > 0 || draft.proposed.trim().length > 0;
}

/** The label of the field the reader writes the wording in, per §2.3. */
export function wordingLabel(draft: Pick<SeamDraft, 'noteOnly' | 'blockId'>): string {
  if (draft.noteOnly) return 'замечание к тексту';
  return draft.blockId === null ? 'замысел главы' : 'как это звучит в книге';
}

/** The submit word: an intervention is transferred, a note is left. */
export function submitLabel(draft: Pick<SeamDraft, 'noteOnly' | 'blockId'>): string {
  if (draft.noteOnly) return 'оставить замечание';
  return draft.blockId === null ? 'заложить замысел' : 'передать';
}
