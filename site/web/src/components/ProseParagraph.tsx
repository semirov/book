import { classifyFrame } from '@book/shared';
import type { CatalogEntry, CommentDto, ComposerInfo, FrameMark, ViewerDto } from '@book/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { wordOffsetIn } from '../dom.ts';
import { citedClass, FilingMark } from './FilingMark.tsx';
import { FILING_PANEL_CLASS } from './FilingPanel.tsx';
import { PROV_PANEL_CLASS } from './ProvenancePanel.tsx';
import { Seam } from './Seam.tsx';
import { SeamPanel } from './SeamPanel.tsx';
import { trackOnce } from '../lib/analytics.ts';
import type { SeamDraft } from '../lib/draft.ts';
import { isFrameParagraph } from '../lib/freeze.ts';
import { filingNumber, isAlive, staleLine } from '../lib/filings.ts';
import { blockElementId } from '../lib/place.ts';
import { proseMarks } from '../lib/proseMarks.ts';
import { anchorFor, firstWord, seamKey } from '../lib/seam.ts';
import { closeSeam, openSeam, useOpenSeam } from '../lib/useSeam.ts';
import { scheduleMarginPass } from '../lib/marginPass.ts';
import { hideFiling, showFiling, useOpenFiling } from '../lib/useFiling.ts';
import { hideRevision, showRevision, useOpenRevision } from '../lib/useRevision.ts';
import { useProvenance } from '../lib/useProvenance.ts';
import { MarginNote } from './MarginNote.tsx';
import { PhoneStrip } from './PhoneStrip.tsx';
import { RevisionObject } from './RevisionObject.tsx';

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
  /** BOOK-158: the page's revise clock, so the card's cooldown line counts down. */
  nowMs?: number;
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** BOOK-111: the posted DTO, so the page shows the reader's own row at once. */
  onPosted: (comment: CommentDto) => void;
  onBlockProvenance?: (blockId: string, anchor: HTMLElement) => void;
  /** STALE_ANCHOR: the chapter reloads, then the draft is re-keyed onto the new text. */
  onReanchor?: (draft: SeamDraft) => void;
  /** The reveal's caret rests after this block (§11.3); printing is the lane's own state. */
  caret?: { printing: boolean; live: boolean } | null;
  /** A rewrite cross-fades in place (§10.4). */
  revised?: boolean;
  /** A step is rewriting this block: the ochre label and rule (§11.5). */
  revising?: string | null;
  /**
   * BOOK-56: `state.history.live`. Off removes the paragraph-chain door («⋯»), the DNA rows
   * in the panel and the trace fetches behind them. The word, its place and «вмешаться»
   * stay; a filing's own mark stays too.
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
  nowMs,
  composer,
  viewer,
  onPosted,
  onBlockProvenance,
  onReanchor,
  caret = null,
  revised = false,
  revising = null,
  history,
}: ProseParagraphProps) {
  const seam = useOpenSeam();
  // BOOK-137 — the paragraph *is* the canon sentence (the basis slot): the one without a rail.
  // Every paragraph of a written chapter has one, ch01 and ch65 alike; a tap still works here.
  const frameOnly = isFrameParagraph(entry.n, text);
  const here = seam !== null && seam.chapter === entry.n && seam.blockId === blockId;
  /**
   * BOOK-111: the page's one panel, not this paragraph's state — a card and a word's panel are
   * the same slot, and only the surface that opened it draws it.
   */
  const filing = useOpenFiling();
  const panel = filing !== null && filing.owner === blockId ? filing : null;
  const filingPanel = panel !== null && panel.kind === 'filing' ? panel : null;
  const provenancePanel = panel !== null && panel.kind === 'provenance' ? panel : null;
  /** BOOK-90: one revision object per chapter — the store, not this paragraph's state. */
  const revision = useOpenRevision();
  const hostRef = useRef<HTMLElement | null>(null);
  const anchor = here ? (seam?.anchor ?? null) : null;
  /**
   * BOOK-137 — the shared rule on the selection: only `touched` is the canon sentence itself.
   * The word panel's «закреплено» variant follows this mark (or a paragraph that *is* the basis
   * sentence), never the chapter number.
   */
  const frame: FrameMark =
    anchor === null
      ? 'untouched'
      : classifyFrame({ chapter: entry.n, quote: anchor.quote, blockIndex, blockText: text, blockCount });
  /**
   * BOOK-DOC-34 §2.6 — the word panel's facts are read by one hook, the same one a filing
   * card's footer goes through: one chain read, one «свой след», and nothing with history off.
   */
  const provenance = useProvenance({
    blockId,
    chapter: entry.n,
    word: provenancePanel?.word ?? null,
    frozen: frame === 'touched' || frameOnly,
    history,
    signedIn: viewer.signedIn,
    viewerName: viewer.displayName,
  });
  const { sentences, groups: blockFilings, marks, alive, key: filingKey } = proseMarks(text, comments, blockId);
  const stale = staleLine(comments.filter((comment) => comment.anchor.blockId === blockId));
  const classes = ['p'];
  if (caret?.printing === true) classes.push('is-printing');
  if (revising !== null) classes.push('is-revising');
  if (revised) classes.push('is-revised');

  const openRevision = useCallback((comment: CommentDto, origin: HTMLElement): void => {
    // BOOK-111: one panel at a time — the store closes the filing card (see `useRevision`).
    showRevision({ comment, origin });
  }, []);

  const closeRevision = useCallback((): void => {
    const origin = revision?.origin ?? null;
    hideRevision();
    // The trigger comes back when the object leaves; a note that was replaced has left the
    // page, and the paragraph is the next honest target (BOOK-90 §3.3).
    if (origin !== null && origin.isConnected) origin.focus();
    else hostRef.current?.focus();
  }, [revision]);

  /** BOOK-111: one way into a filing card — the page's store, owned by this paragraph. */
  const openFiling = useCallback(
    (comment: CommentDto, origin: HTMLElement): void => {
      showFiling({
        kind: 'filing',
        owner: blockId,
        comment,
        origin,
        rect: origin.getBoundingClientRect(),
        // BOOK-111 (owner, 2026-10-27): the tap landed in the strip, so the strip is the same
        // place as the panel — it collapses to one line instead of vanishing behind it.
        fromSeam: origin.closest('.seam') !== null,
      });
    },
    [blockId],
  );

  /** §7: the trigger comes back when the panel leaves, never nowhere. */
  const closePanel = useCallback((): void => {
    const origin = panel?.origin ?? null;
    hideFiling();
    origin?.focus();
  }, [panel]);

  const openAt = useCallback(
    (origin: HTMLElement, offset: number, target: HTMLElement): void => {
      const anchor = anchorFor({ text, blockId, baseRev, offset });
      if (anchor === null) return;
      openSeam({
        chapter: entry.n,
        blockId,
        key: seamKey(entry.n, blockId, anchor.sentence, baseRev),
        anchor,
        origin: target,
      });
      origin.scrollIntoView?.({ block: 'nearest' });
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
      '.filing-mark, .seam-rail, .prov, .seam, .margin-note, .phone-strip, .revision',
    );
    if (control !== null && control !== undefined) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-s]');
    if (target === null || target === undefined) return;
    const start = Number(target.getAttribute('data-s') ?? '0');
    const offset = wordOffsetIn(target, event.clientX, event.clientY) ?? start;
    // The paragraph is the focus target: closing the seam returns the reader to the sentence
    // they touched, not to the top of the page (§7).
    const host = (event.currentTarget as HTMLElement | null) ?? target;
    openAt(host, offset, host);
  };

  // The paragraph's chain answers «кто внёс» and «переписан N раз» for the panel; the hook is
  // the one reader of those facts, and both of the panel's doors go through its `load`.
  const openProvenance = async (at: HTMLElement, word: string): Promise<void> => {
    showFiling({
      kind: 'provenance',
      owner: blockId,
      comment: null,
      origin: at,
      rect: at.getBoundingClientRect(),
      word,
      fromSeam: at.closest('.seam') !== null,
    });
    await provenance.load();
  };

  /** The sentence the strip speaks about: marked inline, never cut out of the flow. */
  const anchoredStart = anchor === null ? -1 : anchor.sentence.start;
  /**
   * BOOK-111 (owner, 2026-10-27) — the strip's sentence and its filing are the two halves of
   * one popover. The strip's own resolution decides which group belongs to this sentence
   * (exact quote first, a single moved group second), so the switch and the strip's rows can
   * never point at different records.
   */
  const seamFilings =
    blockFilings.find((item) => anchor !== null && item.quote === anchor.quote) ??
    (blockFilings.length === 1 ? (blockFilings[0] ?? null) : null);
  const seamFiling = seamFilings?.all[0] ?? null;
  /** The word a filing card may explain: the first of the sentence it quotes. */
  const filingWord = filingPanel === null || filingPanel.comment === null ? null : firstWord(filingPanel.comment.anchor.quote);
  const view = provenance.view;

  /**
   * The provenance panel turns into the sentence's card in the same box: the anchor rect, the
   * origin and `fromSeam` travel unchanged, so the strip stays collapsed and closing the card
   * still returns focus to the button that opened the word.
   */
  const switchToFiling = (comment: CommentDto): void => {
    if (panel === null) return;
    showFiling({ ...panel, kind: 'filing', comment, word: undefined });
  };

  /**
   * The card turns into the provenance of the first word it quotes, in the same box. The chain
   * is read through the same hook the strip's own door uses: same fetches, and with history off
   * nothing is asked at all.
   */
  const switchToProvenance = (word: string): void => {
    if (panel === null) return;
    showFiling({ ...panel, kind: 'provenance', comment: null, word });
    void provenance.load();
  };

  // BOOK-90: the margin is page-wide; this paragraph only tells it that its anchors may have
  // moved (a seam opened, a revision arrived, the text changed).
  useMeasuredLayout(() => {
    scheduleMarginPass();
  }, [filingKey, seam?.key ?? null, text, revision?.comment.id ?? null]);

  /**
   * BOOK-68 — the paragraph is rendered as slices of its own text, never re-assembled.
   *
   * `splitSentences` covers the prose, not every character: the whitespace between two
   * sentences, a closing quote that follows a space, the leading indent and the tail after
   * the last recognised sentence all used to be dropped. Here every character between `from`
   * and `to` reaches the page: a raw gap is a text node, a sentence is one span holding
   * exactly `text.slice(start, end)`, and the tail after the last sentence is raw text.
   * Nothing is invented, so the paragraph reads the same closed, open and closed again.
   */
  const renderRange = (from: number, to: number): ReactNode => {
    const nodes: ReactNode[] = [];
    let cursor = from;
    sentences.forEach((sentence, index) => {
      if (sentence.start < from || sentence.end > to) return;
      // The gap the splitter did not claim — double spaces, a stray quote, an indent.
      if (sentence.start > cursor) nodes.push(text.slice(cursor, sentence.start));
      const filings = marks.get(sentence.start);
      const cited = citedClass(filings);
      // BOOK-68: the seam's own sentence wears one extra class, whose whole effect is the
      // cited rule's underline — text decoration sets no box, so no line moves.
      const marked = [cited, sentence.start === anchoredStart ? 'is-anchored' : null]
        .filter((name): name is string => name !== null && name !== undefined)
        .join(' ');
      nodes.push(
        <span
          key={`${sentence.start}-${index}`}
          className={marked === '' ? undefined : marked}
          data-s={sentence.start}
          data-quote={sentence.text}
        >
          {text.slice(sentence.start, sentence.end)}
          {filings === undefined || filings.stale ? null : (
            <>
              <FilingMark
                filings={filings}
                onOpen={openFiling}
                onOpenRevision={openRevision}
              />
              {filings.all
                .filter(isAlive)
                .filter((comment) => revision?.comment.id !== comment.id)
                .map((comment) => (
                  <MarginNote key={comment.id} comment={comment} onOpen={openRevision} />
                ))}
              {revision !== null && filings.all.some((comment) => comment.id === revision.comment.id) ? (
                <RevisionObject comment={revision.comment} text={text} onClose={closeRevision} />
              ) : null}
            </>
          )}
        </span>,
      );
      cursor = sentence.end;
    });
    // The tail after the last sentence — a paragraph need not end with a full stop.
    if (cursor < to) nodes.push(text.slice(cursor, to));
    return nodes;
  };

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
      onProvenance={(origin) => void openProvenance(origin, anchor?.word ?? anchor?.quote ?? '')}
      onOpenFiling={openFiling}
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
              openAt(event.currentTarget, first.start, event.currentTarget);
            }}
          >
            вмешаться
          </button>
        )}
        {renderRange(0, Number.POSITIVE_INFINITY)}
        {caret === null ? null : (
          <span
            className={`caret-inline${caret.live && !caret.printing ? ' blink' : ''}${caret.printing ? '' : ' resting'}`}
            aria-hidden="true"
          />
        )}
        {onBlockProvenance === undefined || !history ? null : (
          <button
            type="button"
            className="prov"
            aria-label="откуда эта фраза"
            onClick={(event) => onBlockProvenance(blockId, event.currentTarget)}
          >
            ⋯
          </button>
        )}
        {phone}
      </p>
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
      {/*
        BOOK-111 (owner, 2026-10-27): one box, two contexts — one slot in the tree, so a turn
        from the word's record to the sentence's card keeps the very same `<aside>` (and the
        reader's place in it). Two sibling slots would remount the box and hand back a new node.
      */}
      {view !== null && provenancePanel !== null ? (
        <SeamPanel
          context="provenance"
          rootClass={PROV_PANEL_CLASS}
          view={view}
          anchor={provenancePanel.rect}
          onClose={closePanel}
          onForm={hideFiling}
          onFiling={
            provenancePanel.fromSeam && seamFiling !== null ? () => switchToFiling(seamFiling) : undefined
          }
          filingLabel={provenancePanel.fromSeam && seamFiling !== null ? `замечание ${filingNumber(seamFiling)} →` : undefined}
        />
      ) : filingPanel === null || filingPanel.comment === null ? null : (
        // Same contract as the word's panel: same shell, one close, focus back to the mark or row.
        <SeamPanel
          context="filing"
          rootClass={FILING_PANEL_CLASS}
          comment={filingPanel.comment}
          anchor={filingPanel.rect}
          nowMs={nowMs}
          onClose={closePanel}
          onProvenance={filingWord === null ? undefined : () => switchToProvenance(filingWord)}
        />
      )}
    </>
  );
}
