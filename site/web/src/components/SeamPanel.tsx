import type { ChangeSummaryDto, CommentDto } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePanel } from '../lib/cssom.ts';
import { changeLines } from '../lib/changeStatus.ts';
import { anchorCopy, commentStamp, commentStatusLine } from '../lib/commentView.ts';
import { filingNumber } from '../lib/filings.ts';
import { failedAttempt } from '../lib/marginalia.ts';
import { placePopover, samePlacement, viewportOf, type AnchorRect, type PopoverPlacement } from '../lib/popover.ts';
import { frozenActionHref, type ProvenanceView } from '../lib/provenance.ts';
import { reviseView } from '../lib/revise.ts';
import { reviseFiling } from '../lib/useRevise.ts';
import { ReviseNote } from './ReviseNote.tsx';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The two surfaces the one box can be: a word's DNA, or one filing's card. */
export type PanelContext = 'provenance' | 'filing';

/** What the shell owns, whatever it is showing. */
type Shell = {
  /**
   * The surface's own root class (`prov-panel ym-hide-content` / `filing-panel ym-hide-content`).
   * It is handed in, not spelled here: the masking guard (BOOK-77) reads the literal where the
   * surface lives, and the shell adds nothing to it but the placement modifier.
   */
  rootClass: string;
  /** The anchor the panel is placed against; a context change keeps it. */
  anchor: AnchorRect | null;
  /**
   * BOOK-158: the page's revise clock (`useReviseTick`). The card's cooldown line counts down
   * from this value; a caller that does not know it falls back to its own render time.
   */
  nowMs?: number;
  /** The one close on screen — and, with `Escape`, the box's only way out. */
  onClose: () => void;
};

export type ProvenanceContext = Shell & {
  context: 'provenance';
  view: ProvenanceView;
  onForm?: () => void;
  /** The seam's sentence already holds a filing: the same box turns into that card. */
  onFiling?: () => void;
  /** «замечание №A7K →» — the label of that turn. */
  filingLabel?: string;
};

export type FilingContext = Shell & {
  context: 'filing';
  comment: CommentDto;
  /** The card offers the provenance of its sentence's first word, in the same box. */
  onProvenance?: () => void;
  /** BOOK-137: the attempts before the latest one, oldest first; no numbers and no links. */
  earlierAttempts?: readonly ChangeSummaryDto[];
  /** BOOK-137: the premise's derived reading — its change's intent, or null. */
  premiseIntent?: string | null;
  /**
   * BOOK-158 — «исправить» on the card. The surface that raised the card knows how to put it
   * away and open the strip (the chapter's row keeps its own state); without one, the card
   * closes itself and hands the page to the one shared act (`reviseFiling`).
   */
  onRevise?: (comment: CommentDto, origin: HTMLElement) => void;
};

export type SeamPanelProps = ProvenanceContext | FilingContext;

/** The anchored modifier each surface has always carried (§2.6–§2.7). */
const ANCHORED: Record<PanelContext, string> = {
  provenance: 'prov-panel-anchored',
  filing: 'filing-panel-anchored',
};

/**
 * BOOK-DOC-34 §2.6–§2.7 — **one** panel, **one** ✕, two contexts.
 *
 * The owner, on a frozen chapter's word: «Два поповера, нужно чтобы был один или поменялся
 * контекст в существующем». The provenance record and the filing card were never two surfaces
 * — they are the same popover showing the two halves of one thing: what the words are, and
 * what a reader asked of them. This shell is that popover.
 *
 * A context change is a prop change on the same `<aside>`: React keeps the node, the anchor
 * rect and the placement machinery, and the reader keeps their place — only the body, the root
 * class and the accessible name change. Focus goes back into the box after the turn (the shell
 * owns focus, never the bodies), and there is still exactly one close control, because only
 * the head renders one.
 *
 * The bodies are the old surfaces, unchanged: the DNA panel's word, chain, rows, copy and its
 * one action (`вмешаться здесь`, or the frame's rules link), and the filing card's author,
 * quote, body, state and fact. Each gains one quiet footer button — the way to the other half.
 */
export function SeamPanel(props: SeamPanelProps) {
  const { anchor, context, onClose, rootClass } = props;
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  /** The body's own values: the box is measured again whenever what it prints changes. */
  const view = props.context === 'provenance' ? props.view : null;
  const comment = props.context === 'filing' ? props.comment : null;

  // The placement mechanism is the site's one (§2.6): measured once per open, and again when
  // the body changes — the anchor rect is the same, so the box stays over the phrase. The body
  // is a dependency because it arrives in two steps: the first paint is measured with the
  // chain still loading, and the rows that answer it must re-measure the box (otherwise the
  // panel keeps a `maxHeight` taken from an empty body and clips its own grown text).
  useMeasuredLayout(() => {
    if (anchor === null) return;
    const node = panel.current;
    if (node === null || typeof window === 'undefined') return;
    // BOOK-137 — the box is the **visual** viewport, not the layout one: on a phone the URL
    // bar and the keyboard take room from it, and a panel clamped to `innerWidth/innerHeight`
    // opened below the fold.
    const viewport = viewportOf();
    const size = { width: Math.min(420, viewport.width - 24), height: node.scrollHeight };
    const next = placePopover(anchor, size, viewport);
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchor, context, view, comment]);

  useMeasuredLayout(() => {
    placePanel(panel.current, placement);
  }, [placement]);

  // §7: focus moves into the box on open, and again when it turns into the other context —
  // the reader stays in the frame they are reading. The caller returns focus to the trigger
  // when the box closes, which is the only moment the strip gets its rows back.
  useEffect(() => {
    panel.current?.focus();
  }, [context]);

  // One `Escape` for the one box, whatever it is showing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      className={`${rootClass}${placement === null ? '' : ` ${ANCHORED[context]}`}`}
      role="dialog"
      aria-modal="false"
      aria-label={props.context === 'provenance' ? props.view.title : `замечание ${filingNumber(props.comment)}`}
      data-context={context}
      ref={panel}
      tabIndex={-1}
    >
      {props.context === 'provenance' ? <ProvenanceBody {...props} /> : <FilingBody {...props} />}
    </aside>
  );
}

/**
 * BOOK-136 — the card's fact line, from the two things it can say: the deck's detail (a
 * receipt, a refusal, an attempt that came back empty) and, for a premise that still waits,
 * the derived reading of what was accepted into the basis. A failed attempt is never swallowed
 * by the derived reading: the reader gets the human sentence first, then the reading.
 */
function premiseReading(
  comment: CommentDto,
  premiseIntent: string | null,
  detail: string | null,
): string | null {
  if (premiseIntent === null || comment.premise !== true || comment.status === 'applied') return detail;
  const intake = `принято в основу: ${premiseIntent}`;
  return failedAttempt(comment) && detail !== null ? `${detail} · ${intake}` : intake;
}

/** §2.6 — «откуда это слово», the DNA panel, and the door to the sentence's filing. */
function ProvenanceBody({ view, onClose, onForm, onFiling, filingLabel }: ProvenanceContext) {
  return (
    <>
      <div className="prov-head">
        <span className="prov-label">{view.title}</span>
        <button type="button" className="prov-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      <p className="prov-word">
        {view.word} <span className="prov-chapter">{view.chapterLine}</span>
      </p>
      {/* BOOK-56: the chain rows («кто», «правка», «эта страница») are the log's own answer;
          with history off the view carries none, and no empty list is left behind. */}
      {view.chain.length === 0 ? null : (
        <ol className="prov-chain">
          {view.chain.map((node) => (
            <li key={node.label} className="prov-node">
              <span className="prov-node-label">{node.label}</span>
              <span className="prov-node-value">{node.value}</span>
            </li>
          ))}
        </ol>
      )}
      {/* BOOK-56: with history off the view carries no rows — no empty DNA block. */}
      {view.rows.length === 0 ? null : (
        <dl className="prov-rows">
          {view.rows.map((row) => (
            <div className="prov-row" key={row.label} data-quiet={row.quiet === true ? 'true' : undefined}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.copy === null ? null : <p className="prov-copy">{view.copy}</p>}
      {view.action.kind === 'rules' ? (
        <a className="prov-rules" href={frozenActionHref()}>
          {view.action.label}
        </a>
      ) : (
        <button type="button" className="prov-action" onClick={onForm}>
          {view.action.label}
        </button>
      )}
      {/* BOOK-111 (owner, 2026-10-27): the sentence's own filing is the other half of this
          word — the same box turns into it, so no second popover is ever raised. */}
      {onFiling === undefined || filingLabel === undefined ? null : (
        <button type="button" className="prov-filing" onClick={onFiling}>
          {filingLabel}
        </button>
      )}
    </>
  );
}

/**
 * §2.7 — one filing, whole, and the door to the provenance of its sentence's first word.
 *
 * Two lines that must never merge: the decision in the reader's words and the application as a
 * fact. The body is shown whole (this is where a long comment lives; the strip clamps, the
 * panel does not).
 *
 * BOOK-70: the state is printed once, in the form its own text asks for. A state that fits a
 * chip (≤ 24 characters, no clause in it) is a `.filing-state` — one line, 12 px, one of the two
 * inks. A clause or a receipt — an applied filing names the chapter and the right that moved
 * with it — is a `.filing-sentence`: 14 px, the book's voice, and it may wrap, because a clause
 * cut to one line at 320 px either overflows the panel or lies about its length.
 */
function FilingBody({
  comment,
  onClose,
  onProvenance,
  earlierAttempts = [],
  premiseIntent = null,
  nowMs,
  onRevise,
}: FilingContext) {
  const line = commentStatusLine(comment);
  const quote = anchorCopy(comment);
  /** A chip has two inks: `--live` for work in flight, `--ink-3` for everything settled. */
  const ink = line.tone === 'live' ? 'ink-live' : 'ink-quiet';
  /**
   * BOOK-137 — a premise's derived reading: the intent of the change it was taken into, in
   * the change's own words. While the premise waits, that sentence says what was accepted
   * into the basis; a landed premise keeps its receipt («вошло в первую редакцию…»), which is
   * a fact about the book and not a restatement of the reader.
   */
  const reading = premiseReading(comment, premiseIntent, line.detail);
  /**
   * BOOK-158 — a refused filing's card is the second place the reader looks after the row: the
   * hint, the door and the reason the door is shut. The refusal's own sentence is already the
   * card's fact line, so only the hint and the action are printed here.
   */
  const revise = reviseView(comment, nowMs);
  const openRevise = (origin: HTMLElement): void => {
    if (onRevise !== undefined) {
      onRevise(comment, origin);
      return;
    }
    // The card gives the strip the page; the reader is done reading this box.
    onClose();
    reviseFiling(comment, origin);
  };

  return (
    <>
      <div className="filing-head">
        <span className="filing-title">замечание {filingNumber(comment)}</span>
        <button type="button" className="filing-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      <p className="filing-meta">
        {comment.author} · {commentStamp(comment.createdAt)} · глава {String(comment.chapter).padStart(2, '0')}
      </p>
      {quote === null ? null : <p className="filing-quote">«{quote}»</p>}
      <p className="filing-body">{comment.body}</p>
      {line.form === 'sentence' ? (
        <p className="filing-sentence">{line.state}</p>
      ) : (
        <p className={`filing-state ${ink}`}>{line.state}</p>
      )}
      {/*
        BOOK-90: the receipt of a landed change and the reader's reason are the detail — the
        fact the three-word state cannot carry. It was printed as the state itself (BOOK-58/
        BOOK-70); the word now stands alone and this line keeps the fact whole.
      */}
      {reading === null ? null : <p className="filing-fact">{reading}</p>}
      {revise === null ? null : (
        <ReviseNote view={revise} className="filing-revise" onRevise={openRevise} />
      )}
      {/*
        BOOK-137 — the attempts before the latest one, inside the entry they belong to and
        without a number or a link of their own: the entry's quiet line above the card carries
        the one number and the one `прицел` of the latest attempt.
      */}
      {earlierAttempts.length === 0 ? null : (
        <ol className="filing-attempts">
          {earlierAttempts.map((attempt) => {
            const lines = changeLines(attempt);
            return (
              <li className="filing-attempt" key={attempt.id}>
                {lines.first} · {lines.second}
              </li>
            );
          })}
        </ol>
      )}
      {/* BOOK-DOC-34 §2.7, amended by BOOK-111: the phrase this filing is about has its own
          record, and it opens here — one box, two contexts, never a third surface. */}
      {onProvenance === undefined ? null : (
        <button type="button" className="filing-prov" onClick={onProvenance}>
          откуда это слово →
        </button>
      )}
    </>
  );
}
