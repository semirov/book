import type { CatalogEntry, CommentDto, ComposerInfo, ViewerDto } from '@book/shared';
import { FRAME_WARNING } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { track } from '../lib/analytics.ts';
import { holdAnchor } from '../lib/anchorHold.ts';
import { useChangeRead } from '../lib/changeCache.ts';
import { changeBefore } from '../lib/changeView.ts';
import { emptyDraft, seamDrafts, type SeamDraft } from '../lib/draft.ts';
import { filingNumber, isAlive, sortFilings } from '../lib/filings.ts';
import { offsetTopOfPage } from '../lib/headerOffset.ts';
import { keepPlace } from '../lib/keepPlace.ts';
import { filingConsequence } from '../lib/marginalia.ts';
import { useChainRead } from '../lib/paragraphChainCache.ts';
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
import { RecordChangeSection } from './ChangeSection.tsx';
import { InterventionForm } from './InterventionForm.tsx';
import { ExistingFilingNotice, FilingBody, QuoteBody, RowsList, SectionHeader } from './RecordParts.tsx';

/**
 * BOOK-128 comments #3863 / #3862 — **the sentence's record**: one block, in the flow, after
 * the paragraph. Order: the sentence quoted → its hand and moment → the head row (state word ·
 * `вмешаться` · one ✕) → `замечания N` → `правка 014` → `история N`. One section body is open
 * at a time; the form, the receipt and a filing read in full are states of that body.
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
  /**
   * The change the record was opened for (a `?change=` link, a thread's «правка →»). The
   * `правка` section is expanded on mount and the record reads the change itself.
   */
  changeId?: string | null;
  /** The filing's stored quote — the sentence as the change found it. */
  changeQuote?: string | null;
  /** The filing the record was opened for: its body is the record's open one. */
  filing?: CommentDto | null;
  onPosted: (comment: CommentDto) => void;
  onClose: () => void;
  onReanchor?: (draft: SeamDraft) => void;
};

/** `prefers-reduced-motion` → the block is at its final height at t = 0. */
function reduceMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

type Body = 'list' | 'form' | 'notice' | 'receipt' | 'filing';
type Section = 'interventions' | 'change' | 'history';

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
  changeId = null,
  changeQuote = null,
  filing = null,
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
  const [body, setBody] = useState<Body>(filing === null ? 'list' : 'filing');
  const [section, setSection] = useState<Section | null>(changeId === null ? 'interventions' : 'change');
  const changeRead = useChangeRead(changeId, section === 'change');
  const change = changeRead.change;
  const [lifted, setLifted] = useState(false);
  const [openFiling, setOpenFiling] = useState<CommentDto | null>(filing);
  const [receipt, setReceipt] = useState<CommentDto | null>(null);
  const [phase, setPhase] = useState<'enter' | 'open' | 'closing'>('enter');
  const { chain, settled: chainSettled, failed: chainFailed } = useChainRead(blockId);
  const [marker, setMarker] = useState(false);
  const closing = useRef(false);
  const releaseAnchor = useRef<(() => void) | null>(null);
  const closingTimer = useRef<number | null>(null);
  const settledScroll = useRef(false);
  const headRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

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

  /** Release the reading line's hold: the policy's scroll is a movement the reader asked for,
   * and an armed hold would revert it within one frame. */
  const releaseHold = (): void => {
    releaseAnchor.current?.();
    releaseAnchor.current = null;
  };

  /** #3863: after the block opens, bring its top to `viewport bottom − 24` only when that does
   * not move the touched line above the header's edge; otherwise the marker is the offer. */
  const settleScroll = (): void => {
    if (settledScroll.current) return;
    settledScroll.current = true;
    const block = document.querySelector<HTMLElement>('.rec');
    const line = document.querySelector<HTMLElement>('.p [data-touch]');
    if (block === null) return;
    // The block's top lands on the bottom band's edge (the page's own 24 px of foot), so its
    // first control is above the band the reader cannot tap through.
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
      // BOOK-128 #3862 — the form is the first layer: Escape puts it away and leaves the block
      // open with the draft untouched; a second Escape closes the block.
      if (body === 'form' || body === 'notice') {
        setBody('list');
        // The word `вмешаться` is the control again: focus follows the state, not the page.
        window.requestAnimationFrame(() => ctaRef.current?.focus({ preventScroll: true }));
        return;
      }
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
  /** The record speaks about **one sentence**: a block-group filing counts only on its quote. */
  const sorted = (filings === null ? [] : sortFilings(filings)).filter(
    (comment) => anchor === null || comment.anchor.quote === anchor.quote,
  );
  /** The sentence already has a live filing: `вмешаться` must say so, never silently nothing. */
  const aliveFiling = sorted.find(isAlive) ?? null;
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

  /** `QuoteBody` underlines the word inside the quote; never a second node. */
  const quoteStart = anchor?.sentence.start ?? null;

  const markerScroll = (): void => {
    releaseHold();
    const block = document.querySelector<HTMLElement>('.rec');
    if (block === null) return;
    const need = block.getBoundingClientRect().top - (window.innerHeight - 24);
    if (need > 0) window.scrollBy({ top: need, behavior: 'auto' });
    setMarker(false);
  };

  const headState = receipt !== null ? `ждёт · ${filingNumber(receipt)}` : state.word;
  /** #3862 — `вмешаться` is one act: the form, or the live filing said out loud first. */
  const openIntervention = (): void => {
    keepPlace(headRef.current, () => setBody(aliveFiling === null ? 'form' : 'notice'));
  };

  /** The notice's door: the filing that already stands on this sentence, in the same body. */
  const openAliveFiling = (): void => {
    if (aliveFiling === null) return;
    keepPlace(sheetRef.current, () => {
      setOpenFiling(aliveFiling);
      setBody('filing');
    });
  };

  /** One section open at a time; the pressed header stays under the finger. */
  const toggleSection = (next: Section, control: HTMLElement | null): void => {
    keepPlace(control, () => {
      setSection((current) => (current === next ? null : next));
      setLifted(false);
    });
  };

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
          <div className="rec-sheet" ref={sheetRef}>
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
              <blockquote className="rec-quote">
                «<QuoteBody quote={quote} word={word} sentenceStart={quoteStart} />»
              </blockquote>
            )}
            <p className="rec-hand">{hand.line}</p>

            <div className="rec-head" ref={headRef}>
              <span className="rec-state" data-ink={state.ink}>
                {state.situation === 'writing' ? <span className="rec-caret" aria-hidden="true" /> : null}
                {headState === null ? null : <span>{headState}</span>}
              </span>
              {body === 'form' || (body === 'notice' && aliveFiling !== null) ? (
                <span className="rec-act-word">вмешаться</span>
              ) : (
                <button
                  ref={ctaRef}
                  type="button"
                  className="rec-cta"
                  onClick={openIntervention}
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
            ) : body === 'notice' && aliveFiling !== null ? (
              <ExistingFilingNotice
                onOpen={openAliveFiling}
                onNew={() => {
                  keepPlace(headRef.current, () => setBody('form'));
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
              <FilingBody
                comment={openFiling}
                before={
                  openFiling.anchor.quote === null || openFiling.anchor.quote === quote
                    ? null
                    : openFiling.anchor.quote
                }
                after={
                  openFiling.anchor.quote === null || openFiling.anchor.quote === quote ? null : quote
                }
                onBack={() => {
                  keepPlace(sheetRef.current, () => {
                    setBody('list');
                    setOpenFiling(null);
                  });
                }}
              />
            ) : state.empty && changeId === null ? (
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
                      onPress={(control) => toggleSection('interventions', control)}
                    />
                    {section === 'interventions' ? (
                      <RowsList
                        rows={windowed}
                        lifted={lifted}
                        onLift={() => {
                          keepPlace(sheetRef.current, () => setLifted(true));
                        }}
                        onFold={() => {
                          keepPlace(sheetRef.current, () => setLifted(false));
                        }}
                        onOpen={(row) => {
                          keepPlace(sheetRef.current, () => {
                            setOpenFiling(row.comment);
                            setBody('filing');
                          });
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
                {/* The change the record was opened for: the numeral is the header's value,
                    and the section is the change's whole content — there is no sheet behind it. */}
                {changeId === null ? null : (
                  <RecordChangeSection
                    open={section === 'change'}
                    read={changeRead}
                    before={change === null ? null : (changeBefore(change, sorted) ?? changeQuote)}
                    after={quote === '' ? null : quote}
                    onPress={(control) => toggleSection('change', control)}
                  />
                )}
                {history && historyList.length > 0 ? (
                  <>
                    <SectionHeader
                      label="история"
                      count={countOf(historyList)}
                      open={section === 'history'}
                      onPress={(control) => toggleSection('history', control)}
                    />
                    {section === 'history' ? (
                      <RowsList
                        rows={historyWindowed}
                        lifted={lifted}
                        onLift={() => {
                          keepPlace(sheetRef.current, () => setLifted(true));
                        }}
                        onFold={() => {
                          keepPlace(sheetRef.current, () => setLifted(false));
                        }}
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

