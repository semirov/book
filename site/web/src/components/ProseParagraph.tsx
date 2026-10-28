import { classifyFrame } from '@book/shared';
import type { CatalogEntry, ChangeSummaryDto, CommentDto, ComposerInfo, FrameMark, ViewerDto } from '@book/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { wordOffsetIn } from '../dom.ts';
import { FILING_PANEL_CLASS } from './FilingPanel.tsx';
import { Seam } from './Seam.tsx';
import { SeamPanel } from './SeamPanel.tsx';
import { trackOnce } from '../lib/analytics.ts';
import type { SeamDraft } from '../lib/draft.ts';
import { isFrameParagraph } from '../lib/freeze.ts';
import { staleLine, wordFilingOf } from '../lib/filings.ts';
import { blockElementId } from '../lib/place.ts';
import { proseMarks } from '../lib/proseMarks.ts';
import type { WordFiling } from '../lib/provenance.ts';
import { closeRecord, lastTouchOf, openRecord, useOpenRecord } from '../lib/record.ts';
import { anchorFor, seamKey, sentenceAt, wordAt } from '../lib/seam.ts';
import { closeSeam, openSeam, useOpenSeam } from '../lib/useSeam.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';
import { hideFiling, showFiling, useOpenFiling } from '../lib/useFiling.ts';
import { useOpenRevision } from '../lib/useRevision.ts';
import { useParagraphPanels } from '../lib/useParagraphPanels.ts';
import { useProvenance } from '../lib/useProvenance.ts';
import { PhoneStrip } from './PhoneStrip.tsx';
import { RecordSlot } from './RecordSlot.tsx';
import { SentenceRuns } from './SentenceRuns.tsx';
import type { ParagraphChainMode } from '../useParagraphChain.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-DOC-34 §2.1, §2.5 — one paragraph, marked where the reader tapped.
 *
 * Closed and open, the block is the same single `<p>` with the same sentences marked (a cited
 * rule on the sentence, the numeral at its last character). The seam marks its sentence
 * inline — the same underline as a cited one, text decoration only — and lays its strip as a
 * block **after** the paragraph: no fragment boundary, so opening the seam moves no line box
 * and the paragraph keeps the line breaking it had closed (BOOK-68). A tap resolves the
 * sentence from the span it landed in and the word from the caret, so the mark and the
 * provenance are exact.
 */
export type ProseParagraphProps = {
  entry: CatalogEntry;
  blockId: string;
  blockIndex: number;
  baseRev: number;
  /**
   * The prose as the reader has it — during the printing reveal, the prefix printed so far.
   * Its length is the block's `data-chars` (BOOK-89): the folio counts text that is there,
   * and never reads `textContent`, which also carries filing numerals and «вмешаться».
   */
  text: string;
  /** BOOK-137 — the chapter's paragraph count: the shared rule reads the frame's place from it. */
  blockCount: number;
  comments: readonly CommentDto[];
  /**
   * The page's window of changes: a filing's number is the number of the change its latest
   * attempt became (`filingAttempt`), never a filing ordinal the schema does not have.
   */
  changes?: readonly ChangeSummaryDto[];
  /** BOOK-158: the page's revise clock, so the card's cooldown line counts down. */
  nowMs?: number;
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** BOOK-111: the posted DTO, so the page shows the reader's own row at once. */
  onPosted: (comment: CommentDto) => void;
  /**
   * ADR-044 — the phrase's chain mode is no longer read here: the sentence is the door, and the
   * record reads the chain itself. The prop is kept because the page still owns the mode for
   * `ChroniclePast`, and a stale prop is cheaper than a second chain request.
   */
  sentence?: ParagraphChainMode;
  /** STALE_ANCHOR: the chapter reloads, then the draft is re-keyed onto the new text. */
  onReanchor?: (draft: SeamDraft) => void;
  /** The reveal's caret rests after this block (§11.3); printing is the lane's own state. */
  caret?: { printing: boolean; live: boolean } | null;
  /** A rewrite cross-fades in place (§10.4). */
  revised?: boolean;
  /** A step is rewriting this block: the ochre label and rule (§11.5). */
  revising?: string | null;
  /**
   * BOOK-56: `state.history.live`. Off removes both doors («⋯» and the word's) and the fetches
   * behind them. The word, its place and «вмешаться» stay; a filing's own mark stays too.
   */
  history: boolean;
};

export function ProseParagraph({
  entry,
  blockId,
  blockIndex,
  baseRev,
  text,
  blockCount,
  comments,
  changes = [],
  nowMs,
  composer,
  viewer,
  onPosted,
  onReanchor,
  caret = null,
  revised = false,
  revising = null,
  history,
}: ProseParagraphProps) {
  const seam = useOpenSeam();
  /** BOOK-128 #3852 — the page's one block: the touched span and the record it opened. */
  const record = useOpenRecord();
  const recordHere = record !== null && record.chapter === entry.n && record.blockId === blockId;
  /**
   * The mark: solid while the block is open, dotted after it closes, none once another span is
   * touched. It is text decoration on the exact range, so no line box moves by a glyph.
   */
  const touched = recordHere ? { start: record.start, end: record.end } : lastTouchOf(entry.n, blockId);
  // BOOK-137 — the paragraph *is* the canon sentence (the basis slot): the one without a rail.
  // Every paragraph of a written chapter has one, ch01 and ch65 alike; a tap still works here.
  const frameOnly = isFrameParagraph(entry.n, text);
  const here = seam !== null && seam.chapter === entry.n && seam.blockId === blockId;
  /**
   * BOOK-111: the page's one panel, not this paragraph's state — a card and a word's panel are
   * the same slot, and only the surface that opened it draws it.
   */
  /** BOOK-128 #3815 — the `prov` entry means «the word's body is open» in the strip. */
  const filing = useOpenFiling();
  const panel = filing !== null && filing.owner === blockId ? filing : null;
  const filingPanel = panel !== null && panel.kind === 'filing' ? panel : null;
  const provenancePanel = panel !== null && panel.kind === 'provenance' ? panel : null;
  /** BOOK-90: one revision object per chapter — the store, not this paragraph's state. */
  const revision = useOpenRevision();
  const hostRef = useRef<HTMLElement | null>(null);
  const panels = useParagraphPanels({ blockId, hostRef });
  const { openRevision, closeRevision, openFiling, closePanel } = panels;
  const anchor = here ? (seam?.anchor ?? null) : null;
  /**
   * BOOK-128 #3852 — the frame follows whichever surface is speaking for this paragraph: the
   * record the tap opened, or the shipped seam still opened by its own store.
   */
  const speaking = recordHere && record !== null ? record.anchor : anchor;
  /**
   * BOOK-137 — the shared rule on the selection: only `touched` is the canon sentence itself.
   * The word's «закреплено» variant follows this mark (or a paragraph that *is* the basis
   * sentence), never the chapter number.
   */
  const frame: FrameMark =
    speaking === null
      ? 'untouched'
      : classifyFrame({ chapter: entry.n, quote: speaking.quote, blockIndex, blockText: text, blockCount });
  /**
   * Both layers name the same frozen surface: the canon sentence — the paragraph *is* it, or the
   * selection touches it — is `рамка книги`. `основание книги` is page 2, which has no seam yet
   * (`Annotation.tsx` states that gap): a vocabulary both libs keep, not a call.
   */
  const frozenOf: 'frame' | 'basis' | null = frameOnly || frame === 'touched' ? 'frame' : null;
  const { sentences, groups: blockFilings, marks, alive, key: filingKey } = proseMarks(text, comments, blockId);
  /** The filing standing on the strip's sentence: the word's line 3 and its door. */
  const seamFilings =
    blockFilings.find((item) => anchor !== null && item.quote === anchor.quote) ??
    (blockFilings.length === 1 ? (blockFilings[0] ?? null) : null);
  const seamFiling = seamFilings?.all[0] ?? null;
  const wordFiling: WordFiling | null = seamFiling === null ? null : wordFilingOf(seamFiling, changes);
  /** One hook reads the word's facts: one chain, one «свой след», nothing with history off. */
  const provenance = useProvenance({
    blockId,
    word: provenancePanel?.word ?? null,
    frozenOf,
    history,
    signedIn: viewer.signedIn,
    viewerName: viewer.displayName,
    filing: wordFiling,
  });
  const stale = staleLine(comments.filter((comment) => comment.anchor.blockId === blockId));
  const classes = ['p'];
  if (caret?.printing === true) classes.push('is-printing');
  if (revising !== null) classes.push('is-revising');
  if (revised) classes.push('is-revised');

  const openAt = useCallback(
    (offset: number, target: HTMLElement): void => {
      const anchor = anchorFor({ text, blockId, baseRev, offset });
      if (anchor === null) return;
      openSeam({
        chapter: entry.n,
        blockId,
        key: seamKey(entry.n, blockId, anchor.sentence, baseRev),
        anchor,
        origin: target,
      });
    },
    [baseRev, blockId, entry.n, text],
  );

  /**
   * BOOK-128 comment #3852 — a tap opens the block on the **exact range**: the word under the
   * caret, or the whole sentence when there is no word under it. Nothing is scrolled: the line
   * the reader touched is already on screen, and `openAt`'s old `scrollIntoView` was the jump.
   */
  const openTouch = useCallback(
    (
      range: { start: number; end: number },
      origin: HTMLElement | null,
      word: { start: number; end: number } | null = null,
    ): void => {
      const anchor = anchorFor({ text, blockId, baseRev, offset: range.start });
      if (anchor === null) return;
      openRecord({ chapter: entry.n, blockId, start: range.start, end: range.end, word, anchor, origin, surface: 'text' });
    },
    [baseRev, blockId, entry.n, text],
  );

  /**
   * BOOK-63 — the first desktop hover over prose is `tooltip_seen`, once per session: the
   * word's affordance appeared, and that is the act. A touch pointer is not a hover.
   */
  const hint = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse') trackOnce('tooltip_seen', 'tooltip_seen', {});
  };

  /**
   * A tap on a sentence. `pointerup` enforces the tap's own rule (a drag or a long press is
   * not a tap); `click` is the same act arriving from a keyboard or an assistive technology,
   * and it opens the same seam — the two never disagree about the sentence.
   */
  const pick = (event: ReactPointerEvent<HTMLElement> | { target: EventTarget | null; clientX: number; clientY: number; currentTarget?: EventTarget | null }): void => {
    const selection = typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? '');
    if (selection.length > 0) return; // a selection wins: the reader is copying, not filing
    // A tap on the mark, the rail, «⋯» or the strip is that control's own act: the paragraph
    // must not also open a seam (BOOK-33 — the numeral is the button the reader sees).
    const control = (event.target as HTMLElement | null)?.closest(
      '.filing-mark, .seam-rail, .prov, .seam, .margin-note, .phone-strip, .revision, .phone-strip-row, .rec',
    );
    if (control !== null && control !== undefined) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-s]');
    if (target === null || target === undefined) return;
    const start = Number(target.getAttribute('data-s') ?? '0');
    const offset = wordOffsetIn(target, event.clientX, event.clientY) ?? start;
    // ADR-044 / BOOK-128 #3863 — **the sentence is the unit**: a tap anywhere in one opens that
    // sentence's record, and the word under the caret only underlines itself inside the quote.
    const sentenceRange = sentenceAt(text, offset);
    if (sentenceRange === null) return;
    // The sentence is the toggle: a second tap on the open one closes the record.
    if (recordHere && record !== null && record.start === sentenceRange.start) {
      closeRecord();
      // The sentence is the door both ways: closing hands focus back to it, never to `<body>`.
      const door = target.querySelector<HTMLElement>('.sentence-door') ?? target;
      door.focus({ preventScroll: true });
      return;
    }
    const word = wordAt(text, offset);
    const inside = word !== null && word.start >= sentenceRange.start && word.end <= sentenceRange.end ? word : null;
    const host = (event.currentTarget as HTMLElement | null) ?? target;
    openTouch(
      { start: sentenceRange.start, end: sentenceRange.end },
      host,
      inside === null ? null : { start: inside.start, end: inside.end },
    );
  };

  // The phrase's facts (the word's own line 3) and the strip's body are read by one hook.
  const openProvenance = async (at: HTMLElement): Promise<void> => {
    // BOOK-128 comment #3815 — the door toggles: a second press puts the body away and hands
    // focus back to the door, which is the whole of the strip's dismissal contract.
    if (provenancePanel !== null) {
      hideFiling();
      at.focus();
      return;
    }
    showFiling({
      kind: 'provenance',
      owner: blockId,
      comment: null,
      origin: at,
      rect: at.getBoundingClientRect(),
      word: anchor?.word ?? anchor?.quote ?? '',
      // The body is the strip's own: the strip stays, and stays the one place.
      fromSeam: true,
    });
    await provenance.load();
  };

  /** The sentence the strip speaks about: marked inline, never cut out of the flow. */
  const anchoredStart = anchor === null ? -1 : anchor.sentence.start;
  const view = provenance.view;

  /** Line 3 opens the filing standing on the word, in the site's one panel. */
  const openWordFiling = (origin: HTMLElement): void => {
    if (seamFiling === null) return;
    openFiling(seamFiling, origin);
  };

  // BOOK-90: the margin is page-wide; this paragraph only says its anchors may have moved.
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [filingKey, seam?.key ?? null, text, revision?.comment.id ?? null]);

  /**
   * BOOK-128 #3852 — the prose is the sentences' own runs (`SentenceRuns`), with the touched
   * range marked inside its sentence. The paragraph renders no geometry and holds no text.
   */
  const whole = (): ReactNode => (
    <SentenceRuns
      text={text}
      sentences={sentences}
      marks={marks}
      anchoredStart={anchoredStart}
      touched={touched}
      recordHere={recordHere}
      roving={history}
      frozen={frozenOf === 'frame'}
      controls={`rec-${entry.n}-${blockId}`}
      onToggle={(range) => {
        // The sentence is the toggle **for its own record**: pressing another sentence while a
        // record is open swaps it, it does not close the block (pointer and keyboard alike).
        if (recordHere && record !== null && record.start === range.start) closeRecord();
        else openTouch(range, null);
      }}
      onOpenFiling={openFiling}
      onOpenRevision={openRevision}
      onCloseRevision={closeRevision}
      revision={revision}
    />
  );

  const strip = here ? (
    <Seam
      // The seam's key is its identity: a re-keyed draft must remount, or the strip keeps the
      // stale revision it opened with (BOOK-33).
      key={seam?.key ?? `ch${entry.n}:${blockId}`}
      entry={entry}
      draftKey={seam?.key ?? `ch${entry.n}:${blockId}`}
      blockIndex={blockIndex}
      anchor={anchor}
      frame={frame}
      filings={seamFilings}
      composer={composer}
      viewer={viewer}
      onPosted={onPosted}
      onClose={() => {
        const origin = seam?.origin ?? null;
        closeSeam();
        origin?.focus();
      }}
      onClosePanel={closePanel}
      onReanchor={onReanchor}
      onProvenance={(origin) => void openProvenance(origin)}
      onOpenFiling={openFiling}
      // The door exists while history is live (BOOK-128 §8: no door to an empty room); the body
      // under it is opened by that door, and drawn only once the log has answered.
      prov={history ? { view, failed: provenance.failed, onFiling: openWordFiling, onClose: closePanel } : null}
    />
  ) : null;

  // BOOK-90 §4: the phone strip is the paragraph's last child, after every sentence. A row
  // whose sentence has its seam open is skipped — the seam's own rows already show it.
  const phone =
    alive.length === 0 ? null : (
      <PhoneStrip comments={alive} skipQuote={anchor?.quote ?? null} onOpen={openRevision} />
    );

  return (
    <>
      {/*
        BOOK-68 — one `<p>` in both states, the very same element: closing the seam returns
        the paragraph it opened from, with the line breaking it had. The strip is a block
        sibling below it, never a fragment between two halves of the text.
      */}
      <p
        ref={(node) => {
          hostRef.current = node;
        }}
        className={classes.join(' ')}
        id={blockElementId(entry.n, blockIndex)}
        data-block-id={blockId}
        data-chars={text.length}
        tabIndex={-1}
        data-revising={revising ?? undefined}
        onPointerUp={pick}
        onClick={pick}
        onPointerEnter={hint}
      >
        {revising === null ? null : <span className="revising-label">{revising}</span>}
        {frameOnly ? null : (
          <button
            type="button"
            className="seam-rail"
            aria-label="вмешаться"
            onClick={(event) => {
              const first = sentences[0];
              if (first === undefined) return;
              openAt(first.start, event.currentTarget);
            }}
          >
            вмешаться
          </button>
        )}
        {whole()}
        {caret === null ? null : (
          <span
            className={`caret-inline${caret.live && !caret.printing ? ' blink' : ''}${caret.printing ? '' : ' resting'}`}
            aria-hidden="true"
          />
        )}
        {/* ADR-044 — the paragraph's keyboard door is its first sentence (`SentenceRuns`
            roving tabindex), so no separate glyph or hidden control stands at the end. */}
        {phone}
      </p>
      {/*
        BOOK-128 comment #3852 — the block is a sibling **after** the paragraph, never inside it:
        the paragraph's line boxes, its width and its last line are untouched, and only what
        stands below the block moves, by the block's height, once, and back on close.
      */}
      {recordHere && record !== null ? (
        <RecordSlot
          record={record}
          entry={entry}
          blockId={blockId}
          blockIndex={blockIndex}
          baseRev={baseRev}
          frozen={frozenOf}
          writing={revising !== null}
          filings={seamFilings?.all ?? null}
          composer={composer}
          viewer={viewer}
          history={history}
          hostRef={hostRef}
          onPosted={onPosted}
          {...(onReanchor === undefined ? {} : { onReanchor })}
        />
      ) : null}
      {strip}
      {stale === null ? null : (
        <button
          type="button"
          className="p-stale"
          onClick={(event) => {
            const first = comments.find((comment) => comment.anchor.blockId === blockId && !comment.anchor.resolved);
            if (first !== undefined) openFiling(first, event.currentTarget);
          }}
        >
          {stale}
        </button>
      )}
      {/* BOOK-111: one box, one ✕ — and since #3815 the card is the only floating frame here. */}
      {filingPanel === null || filingPanel.comment === null ? null : (
        <SeamPanel
          rootClass={FILING_PANEL_CLASS}
          comment={filingPanel.comment}
          anchor={filingPanel.rect}
          nowMs={nowMs}
          onClose={closePanel}
        />
      )}
    </>
  );
}
