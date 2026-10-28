import type { CatalogEntry, CommentDto, ComposerInfo, ParagraphChainDto, ViewerDto } from '@book/shared';
import { FRAME_WARNING } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { track } from '../lib/analytics.ts';
import { holdAnchor } from '../lib/anchorHold.ts';
import { emptyDraft, seamDrafts, type SeamDraft } from '../lib/draft.ts';
import { filingNumber, sortFilings } from '../lib/filings.ts';
import { offsetTopOfPage } from '../lib/headerOffset.ts';
import { filingConsequence } from '../lib/marginalia.ts';
import { knownParagraphChain, loadParagraphChain } from '../lib/paragraphChainCache.ts';
import {
  countOf,
  handOf,
  historyRows,
  interventionRows,
  isOwn,
  recordStateOf,
  rowWindow,
  type RecordState,
} from '../lib/recState.ts';
import { seamKey, type SeamAnchor } from '../lib/seam.ts';
import { InterventionForm } from './InterventionForm.tsx';
import { FilingBody, RowsList, SectionHeader } from './RecordParts.tsx';

/**
 * BOOK-128 comments #3863 / #3862 — **the sentence's record**: one block, in the flow, after
 * the paragraph.
 *
 * Order: the sentence quoted (the touched word underlined inside it) → the hand and its moment
 * → the head row (state word · `вмешаться` · one ✕) → `замечания N` (open, the reader's own
 * first) → `история N` (closed) → `связи N` (not rendered while the ledger has no route). One
 * section's body is open at a time; the form, the receipt and a filing read in full are states
 * of the same body, never a second surface.
 *
 * Geometry is `record.css` and nothing here measures the design: the block grows with its
 * content, never scrolls, and the page's tail carries what stands below it.
 */

export type RecordProps = {
  entry: CatalogEntry;
  blockId: string;
  blockIndex: number;
  baseRev: number;
  /** The sentence the record belongs to. */
  start: number;
  end: number;
  /** The word the tap landed on, in paragraph offsets — underlined inside the quote. */
  word: { start: number; end: number } | null;
  anchor: SeamAnchor | null;
  /** `рамка книги` / `основание книги` / none. */
  frozen: 'frame' | 'basis' | null;
  /** A pass is writing this paragraph now: `пишется`. */
  writing: boolean;
  /** The sentence's filings, the reader's own first. */
  filings: CommentDto[] | null;
  composer: ComposerInfo;
  viewer: ViewerDto;
  history: boolean;
  onPosted: (comment: CommentDto) => void;
  onClose: () => void;
  onReanchor?: (draft: SeamDraft) => void;
};

/** `prefers-reduced-motion` → the block is at its final height at t = 0. */
function reduceMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

type Body = 'list' | 'form' | 'receipt' | 'filing';
type Section = 'interventions' | 'history';

export function Record({
  entry,
  blockId,
  blockIndex,
  baseRev,
  start,
  end,
  word,
  anchor,
  frozen,
  writing,
  filings,
  composer,
  viewer,
  history,
  onPosted,
  onClose,
  onReanchor,
}: RecordProps) {
  const draftKey = seamKey(entry.n, blockId, anchor?.sentence ?? { text: '', start, end }, baseRev);
  const [draft, setDraftState] = useState<SeamDraft>(
    () =>
      seamDrafts.read(draftKey) ??
      emptyDraft({ chapter: entry.n, blockId, sentence: anchor?.quote ?? '', baseRev, blockIndex }),
  );
  const [body, setBody] = useState<Body>('list');
  const [section, setSection] = useState<Section | null>('interventions');
  const [lifted, setLifted] = useState(false);
  const [openFiling, setOpenFiling] = useState<CommentDto | null>(null);
  const [receipt, setReceipt] = useState<CommentDto | null>(null);
  const [phase, setPhase] = useState<'enter' | 'open' | 'closing'>('enter');
  const [chain, setChain] = useState<ParagraphChainDto | null>(() => {
    const memo = knownParagraphChain(blockId);
    return memo.known ? memo.chain : null;
  });
  const [chainSettled, setChainSettled] = useState(() => knownParagraphChain(blockId).known);
  const [chainFailed, setChainFailed] = useState(false);
  const [marker, setMarker] = useState(false);
  const closing = useRef(false);
  const releaseAnchor = useRef<(() => void) | null>(null);
  const closingTimer = useRef<number | null>(null);
  const settledScroll = useRef(false);

  useEffect(() => {
    if (knownParagraphChain(blockId).known) return;
    void loadParagraphChain(blockId)
      .then((loaded) => {
        setChain(loaded);
        setChainSettled(true);
      })
      .catch(() => {
        setChainFailed(true);
        setChainSettled(true);
      });
  }, [blockId]);

  // The reader's line is taken before the height arrives and put back after it (`anchorHold`).
  useLayoutEffect(() => {
    releaseAnchor.current = holdAnchor();
    return () => {
      releaseAnchor.current?.();
      releaseAnchor.current = null;
    };
  }, []);

  // Mount at 0fr, open on the next frame after the log has answered: the facts are part of the
  // first visible pixel, so the height it opens to is the height it keeps.
  useEffect(() => {
    if (phase !== 'enter' || !chainSettled) return;
    if (reduceMotion()) {
      setPhase('open');
      return;
    }
    const id = requestAnimationFrame(() => setPhase('open'));
    return () => cancelAnimationFrame(id);
  }, [phase, chainSettled]);

  // A read that never settles must not leave the block invisible.
  useEffect(() => {
    const timer = window.setTimeout(
      () => setPhase((current) => (current === 'enter' ? 'open' : current)),
      1200,
    );
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * Release the reading line's hold. The hold corrects every movement of its probe, and the
   * policy below is a movement **the reader asked for**: left armed, it would revert the
   * policy's scroll within one frame and leave the block below the fold with no marker.
   */
  const releaseHold = (): void => {
    releaseAnchor.current?.();
    releaseAnchor.current = null;
  };

  /**
   * The long-paragraph policy (#3863, the owner's numbers): after the block opens, bring its
   * top to `viewport bottom − 24` **only** if that does not move the touched line above the
   * header's lower edge; otherwise leave the page alone and offer the marker instead. It runs
   * after the disclosure (240 ms), so the height is final and the hold has nothing left to do.
   */
  const settleScroll = (): void => {
    if (settledScroll.current) return;
    settledScroll.current = true;
    const block = document.querySelector<HTMLElement>('.rec');
    const line = document.querySelector<HTMLElement>('.p [data-touch]');
    if (block === null) return;
    const bottom = window.innerHeight - 24;
    const top = block.getBoundingClientRect().top;
    // The block is already on screen (or has nowhere to go): the policy does nothing, and the
    // hold keeps owning the line until its own still frames end.
    if (top <= bottom) return;
    const need = Math.min(top - bottom, block.getBoundingClientRect().height);
    if (need <= 0) return;
    // From here the page is moved **on purpose**: the hold must not take it back.
    releaseHold();
    const lineTop = line?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    if (lineTop - need < offsetTopOfPage() + 8) {
      setMarker(true);
      return;
    }
    // One instant step, never `smooth` — the same rule the hold follows.
    window.scrollBy({ top: need, behavior: 'auto' });
  };

  useEffect(() => {
    if (phase !== 'open') return;
    const id = window.setTimeout(settleScroll, reduceMotion() ? 0 : 240);
    return () => window.clearTimeout(id);
    // Once per open; a section switch does not re-run the policy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const close = (): void => {
    if (closing.current) return;
    closing.current = true;
    if (reduceMotion()) {
      onClose();
      return;
    }
    setPhase('closing');
    closingTimer.current = window.setTimeout(onClose, 150);
  };

  useEffect(
    () => () => {
      if (closingTimer.current !== null) window.clearTimeout(closingTimer.current);
    },
    [],
  );

  // `✕` is the pointer's; Escape is its keyboard twin — from any state, the form included.
  // The handler reads the latest `close` through a ref, so it is bound once per body state
  // instead of being torn down and re-added on every render.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (body === 'filing') {
        setBody('list');
        setOpenFiling(null);
        return;
      }
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [body]);

  const update = (next: SeamDraft): void => {
    setDraftState(next);
    seamDrafts.keep(draftKey, next);
  };

  const own = (comment: CommentDto): boolean => isOwn(comment, viewer.displayName);
  const sorted = filings === null ? [] : sortFilings(filings);
  const state: RecordState = recordStateOf({
    filings: sorted,
    own,
    chain,
    writing,
    frozen,
  });
  const hand = handOf({ chain, frozen });
  const rows = interventionRows({ filings: sorted, own });
  const windowed = rowWindow(rows, lifted);
  const historyList = historyRows(chain);
  const historyWindowed = rowWindow(historyList, lifted);
  const quote = anchor?.quote ?? '';

  /** The quote with the touched word underlined — decoration only, no box, no second node. */
  const quoteBody = (): ReactNode => {
    if (word === null || anchor === null) return quote;
    const from = word.start - anchor.sentence.start;
    const to = word.end - anchor.sentence.start;
    if (from < 0 || to > quote.length || to <= from) return quote;
    return (
      <>
        {quote.slice(0, from)}
        <span className="rec-word">{quote.slice(from, to)}</span>
        {quote.slice(to)}
      </>
    );
  };

  const markerScroll = (): void => {
    releaseHold();
    const block = document.querySelector<HTMLElement>('.rec');
    if (block === null) return;
    const need = block.getBoundingClientRect().top - (window.innerHeight - 24);
    if (need > 0) window.scrollBy({ top: need, behavior: 'auto' });
    setMarker(false);
  };

  const headState = receipt !== null ? `ждёт · ${filingNumber(receipt)}` : state.word;

  return (
    <div
      className="rec ym-hide-content"
      data-acc={phase === 'open' ? 'open' : 'closed'}
      data-body={body}
      data-situation={state.situation}
      role="region"
      id={`rec-${String(entry.n)}-${blockId}`}
      aria-label={quote === '' ? 'запись о фразе' : `запись о фразе · ${quote}`}
    >
      <div className="rec-clip" inert={phase === 'open' ? undefined : true}>
        <div className="rec-inner">
          <div className="rec-gap" aria-hidden="true" />
          <div className="rec-sheet">
            {marker ? (
              <button type="button" className="rec-marker" onClick={markerScroll}>
                запись ниже ↓
              </button>
            ) : null}

            {/* BOOK-128 #3862 §3 — a failed read prints the hand only: an absent layer must
                not say «nobody touched it», and must not quote a sentence it did not read. */}
            {chainFailed ? (
              <p className="rec-line rec-quiet">история не прочиталась</p>
            ) : (
              <blockquote className="rec-quote">«{quoteBody()}»</blockquote>
            )}
            <p className="rec-hand">{hand.line}</p>

            <div className="rec-head">
              <span className="rec-state" data-ink={state.ink}>
                {state.situation === 'writing' ? <span className="rec-caret" aria-hidden="true" /> : null}
                {headState === null ? null : <span>{headState}</span>}
              </span>
              {body === 'form' ? (
                <span className="rec-act-word">вмешаться</span>
              ) : (
                <button
                  type="button"
                  className="rec-cta"
                  onClick={() => {
                    setBody('form');
                    track('form_open', {});
                  }}
                >
                  вмешаться
                </button>
              )}
              <button type="button" className="rec-close" aria-label="закрыть" onClick={close}>
                ✕
              </button>
            </div>
            {state.line === null ? null : <p className="rec-state-line">{state.line}</p>}
            {/* BOOK-137 — the frozen frame says before typing what will not move. */}
            {frozen !== null ? (
              <p className="rec-frame-note">
                <a className="rec-frozen" href="/rules#рамка">
                  рамка книги →
                </a>{' '}
                {FRAME_WARNING}
              </p>
            ) : null}

            {body === 'form' ? (
              <InterventionForm
                entry={entry}
                draft={draft}
                composer={composer}
                viewer={viewer}
                onChange={update}
                {...(onReanchor === undefined ? {} : { onReanchor })}
                onPosted={(comment) => {
                  seamDrafts.drop(draftKey);
                  setBody('receipt');
                  setReceipt(comment);
                  track('receipt_seen', {});
                  onPosted(comment);
                }}
              />
            ) : body === 'receipt' && receipt !== null ? (
              <div className="rec-receipt-body">
                <p className="rec-receipt" role="status">
                  {`принято · ${filingNumber(receipt)}`}
                </p>
                <p className="rec-line rec-quiet">{filingConsequence(receipt)}</p>
                {state.line === null ? null : <p className="rec-line rec-quiet">{state.line}</p>}
              </div>
            ) : body === 'filing' && openFiling !== null ? (
              <FilingBody comment={openFiling} onBack={() => { setBody('list'); setOpenFiling(null); }} />
            ) : state.empty ? (
              <p className="rec-empty">{state.line}</p>
            ) : (
              <div className="rec-sections">
                {/* A section with nothing is not a section: `замечания` prints no header when
                    the sentence holds no filing (no count of zero, no empty list). */}
                {rows.length > 0 ? (
                  <>
                    <SectionHeader
                      label="замечания"
                      count={countOf(rows)}
                      open={section === 'interventions'}
                      onPress={() => {
                        setSection((current) => (current === 'interventions' ? null : 'interventions'));
                        setLifted(false);
                      }}
                    />
                    {section === 'interventions' ? (
                      <RowsList
                        rows={windowed}
                        lifted={lifted}
                        onLift={() => setLifted(true)}
                        onFold={() => setLifted(false)}
                        total={rows.length}
                        onOpen={(row) => {
                          setOpenFiling(row.comment);
                          setBody('filing');
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
                {history && historyList.length > 0 ? (
                  <>
                    <SectionHeader
                      label="история"
                      count={countOf(historyList)}
                      open={section === 'history'}
                      onPress={() => {
                        setSection((current) => (current === 'history' ? null : 'history'));
                        setLifted(false);
                      }}
                    />
                    {section === 'history' ? (
                      <RowsList
                        rows={historyWindowed}
                        lifted={lifted}
                        onLift={() => setLifted(true)}
                        onFold={() => setLifted(false)}
                        total={historyList.length}
                        history
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

