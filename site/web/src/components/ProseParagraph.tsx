import type { CatalogEntry, CommentDto, ComposerInfo, ParagraphChainDto, ViewerDto } from '@book/shared';
import { useCallback, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { getAuthors, getHistoryParagraph, getMyTrace } from '../api.ts';
import { citedClass, FilingMark } from './FilingMark.tsx';
import { FilingPanel } from './FilingPanel.tsx';
import { ProvenancePanel } from './ProvenancePanel.tsx';
import { Seam } from './Seam.tsx';
import type { SeamDraft } from '../lib/draft.ts';
import { isFrozenChapter } from '../lib/freeze.ts';
import { filingsForBlock, staleLine } from '../lib/filings.ts';
import { provenanceView, shareFor, type ProvenanceVariant, type TraceShare } from '../lib/provenance.ts';
import { anchorFor, clampQuote, seamKey, splitSentences } from '../lib/seam.ts';
import { closeSeam, openSeam, useOpenSeam } from '../lib/useSeam.ts';

/**
 * BOOK-DOC-34 §2.1, §2.5 — one paragraph, parted where the reader tapped.
 *
 * Closed, the block is one `<p>` with its sentences marked (a cited rule on the sentence, the
 * numeral at its last character). Open, the block becomes two fragments with the strip laid
 * between them: the text is never altered, only parted, and the second fragment keeps the
 * paragraph's own hyphenation and `text-wrap`. A tap resolves the sentence from the span it
 * landed in and the word from the caret, so the mark and the provenance are exact.
 */
export type ProseParagraphProps = {
  entry: CatalogEntry;
  blockId: string;
  blockIndex: number;
  baseRev: number;
  text: string;
  frozen: boolean;
  comments: readonly CommentDto[];
  composer: ComposerInfo;
  viewer: ViewerDto;
  onPosted: (chapter: number) => void;
  onBlockProvenance?: (blockId: string, anchor: HTMLElement) => void;
  /** STALE_ANCHOR: the chapter reloads, then the draft is re-keyed onto the new text. */
  onReanchor?: (draft: SeamDraft) => void;
  /** The reveal's caret rests after this block (§11.3); printing is the lane's own state. */
  caret?: { printing: boolean; live: boolean } | null;
  /** A rewrite cross-fades in place (§10.4). */
  revised?: boolean;
  /** A step is rewriting this block: the ochre label and rule (§11.5). */
  revising?: string | null;
};

type PanelState =
  | { kind: 'provenance'; word: string; rect: DOMRect; origin: HTMLElement | null }
  | { kind: 'filing'; comment: CommentDto; rect: DOMRect; origin: HTMLElement | null }
  | null;

export function ProseParagraph({
  entry,
  blockId,
  blockIndex,
  baseRev,
  text,
  frozen,
  comments,
  composer,
  viewer,
  onPosted,
  onBlockProvenance,
  onReanchor,
  caret = null,
  revised = false,
  revising = null,
}: ProseParagraphProps) {
  const seam = useOpenSeam();
  const frozenChapter = frozen || isFrozenChapter(entry);
  const here = seam !== null && seam.chapter === entry.n && seam.blockId === blockId;
  const [panel, setPanel] = useState<PanelState>(null);
  const [chain, setChain] = useState<ParagraphChainDto | null>(null);
  const [own, setOwn] = useState<{ share: number; survivedRevisions: number } | null>(null);
  const [publicShares, setPublicShares] = useState<Array<{ label: string; share: number; edits: number }>>([]);
  const blockFilings = filingsForBlock(comments, blockId);
  const stale = staleLine(comments.filter((comment) => comment.anchor.blockId === blockId));
  const classes = ['p'];
  if (caret?.printing === true) classes.push('is-printing');
  if (revising !== null) classes.push('is-revising');
  if (revised) classes.push('is-revised');

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
      setPanel(null);
      origin.scrollIntoView?.({ block: 'nearest' });
    },
    [baseRev, blockId, entry.n, text],
  );

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
    const control = (event.target as HTMLElement | null)?.closest('.filing-mark, .seam-rail, .prov, .seam');
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

  // The paragraph's chain answers «кто внёс» and «переписан N раз» for the panel.
  const openProvenance = async (at: HTMLElement, word: string): Promise<void> => {
    setPanel({ kind: 'provenance', word, rect: at.getBoundingClientRect(), origin: at });
    if (chain === null) {
      try {
        setChain(await getHistoryParagraph(blockId));
      } catch {
        /* the panel says what it can without the chain */
      }
    }
    // BOOK-33: the viewer's own curve is the one the panel may print for their own word, and
    // the authors list carries the public numbers for somebody else's. Own-only, always.
    if (viewer.signedIn && own === null) {
      try {
        const trace = await getMyTrace();
        setOwn({ share: trace.share, survivedRevisions: trace.survivedRevisions });
      } catch {
        /* a signed-out session that expired: the row falls back to the public shape */
      }
    }
    if (publicShares.length === 0) {
      try {
        const authors = await getAuthors();
        setPublicShares(authors.contributors.map((row) => ({ label: row.label, share: row.share, edits: row.edits })));
      } catch {
        /* no public list: a foreign word says «след не измерен», never a borrowed number */
      }
    }
  };

  // Who wrote this version, from the log's own vocabulary: a reader, the author, or a
  // version the log cannot assign. A chain that has not arrived yet is not a claim — it is
  // the machine default, and the panel re-renders when the chain answers.
  const actorKind = chain?.versions.at(-1)?.actor?.kind;
  const variant: ProvenanceVariant = frozen
    ? 'frozen'
    : actorKind === 'reader'
      ? 'reader'
      : actorKind === undefined || actorKind === 'author' || actorKind === 'writer'
        ? 'machine'
        : 'unattributed';
  const lastActor = chain?.versions.at(-1)?.actor ?? null;
  const share: TraceShare =
    panel?.kind !== 'provenance'
      ? { kind: 'none' }
      : shareFor({
          actor: lastActor === null ? null : { kind: lastActor.kind, label: lastActor.label },
          viewerName: viewer.displayName,
          own,
          publicShares,
        });
  const view =
    panel?.kind === 'provenance'
      ? provenanceView({
          word: panel.word,
          chapter: entry.n,
          variant,
          share,
          chain,
          at: chain?.versions.at(-1)?.at ?? null,
          frozenOf: 'frame',
        })
      : null;

  const sentences = splitSentences(text);
  const anchor = here ? (seam?.anchor ?? null) : null;
  const cut = anchor === null ? -1 : anchor.sentence.end;

  const renderSentences = (from: number, to: number): ReactNode => {
    return sentences.map((sentence, index) => {
      if (sentence.start < from || sentence.end > to) return null;
      // The anchor quote is clamped to the server's bound, so a long sentence is matched by
      // the same clamp the filing was made with — not by its raw text (BOOK-33).
      const quote = clampQuote(sentence.text);
      const filings = blockFilings.find((item) => item.quote !== null && item.quote === quote);
      const cited = citedClass(filings);
      return (
        <span
          key={`${sentence.start}-${index}`}
          className={cited === null ? undefined : cited}
          data-s={sentence.start}
          data-quote={sentence.text}
        >
          {sentence.text}
          {filings === undefined || filings.stale ? null : (
            <FilingMark filings={filings} onOpen={(comment, origin) =>
              setPanel({ kind: 'filing', comment, rect: origin.getBoundingClientRect(), origin })
            } />
          )}
          {index === sentences.length - 1 ? null : ' '}
        </span>
      );
    });
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
      frozen={frozenChapter}
      filings={
        blockFilings.find((item) => anchor !== null && item.quote === anchor.quote) ?? (blockFilings.length === 1 ? blockFilings[0]! : null)
      }
      composer={composer}
      viewer={viewer}
      onPosted={onPosted}
      onClose={() => {
        const origin = seam?.origin ?? null;
        closeSeam();
        origin?.focus();
      }}
      onReanchor={onReanchor}
      onProvenance={(origin) => void openProvenance(origin, anchor?.word ?? anchor?.quote ?? '')}
      onOpenFiling={(comment, origin) =>
        setPanel({ kind: 'filing', comment, rect: origin.getBoundingClientRect(), origin })
      }
    />
  ) : null;

  const body =
    anchor === null ? (
      renderSentences(0, Number.POSITIVE_INFINITY)
    ) : (
      <>
        {renderSentences(0, cut)}
        {strip}
        {renderSentences(cut, Number.POSITIVE_INFINITY)}
      </>
    );

  return (
    <>
      {anchor === null ? (
        <p
          className={classes.join(' ')}
          data-block-id={blockId}
          tabIndex={-1}
          data-revising={revising ?? undefined}
          onPointerUp={pick}
          onClick={pick}
        >
          {revising === null ? null : <span className="revising-label">{revising}</span>}
          {frozenChapter ? null : (
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
          {body}
          {caret === null ? null : (
            <span
              className={`caret-inline${caret.live && !caret.printing ? ' blink' : ''}${caret.printing ? '' : ' resting'}`}
              aria-hidden="true"
            />
          )}
          {onBlockProvenance === undefined ? null : (
            <button
              type="button"
              className="prov"
              aria-label="откуда эта фраза"
              onClick={(event) => onBlockProvenance(blockId, event.currentTarget)}
            >
              ⋯
            </button>
          )}
        </p>
      ) : (
        <div
          className={`${classes.join(' ')} p-parted`}
          data-block-id={blockId}
          tabIndex={-1}
          data-revising={revising ?? undefined}
          onPointerUp={pick}
          onClick={pick}
        >
          {body}
        </div>
      )}
      {stale === null ? null : (
        <button
          type="button"
          className="p-stale"
          onClick={(event) => {
            const first = comments.find((comment) => comment.anchor.blockId === blockId && !comment.anchor.resolved);
            if (first !== undefined) setPanel({ kind: 'filing', comment: first, rect: event.currentTarget.getBoundingClientRect(), origin: event.currentTarget });
          }}
        >
          {stale}
        </button>
      )}
      {view === null || panel?.kind !== 'provenance' ? null : (
        <ProvenancePanel
          view={view}
          anchor={panel.rect}
          onClose={() => {
            // Focus returns to the cluster that opened the panel (§7), not nowhere.
            const origin = panel?.origin ?? null;
            setPanel(null);
            origin?.focus();
          }}
          onForm={() => setPanel(null)}
        />
      )}
      {panel?.kind === 'filing' ? (
        <FilingPanel
          comment={panel.comment}
          anchor={panel.rect}
          onClose={() => {
            // Same contract as the provenance panel: focus goes back to the mark or row.
            const origin = panel.origin;
            setPanel(null);
            origin?.focus();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The caret offset inside the tapped sentence span, in characters from the block's start.
 * `caretPositionFromPoint` is Firefox, `caretRangeFromPoint` is Chrome/Safari; a browser with
 * neither falls back to the sentence's own start, which still names the right sentence.
 */
function wordOffsetIn(target: HTMLElement, x: number, y: number): number | null {
  const start = Number(target.getAttribute('data-s') ?? '0');
  if (typeof document === 'undefined') return null;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let within = 0;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position !== null && position !== undefined) {
    node = position.offsetNode;
    within = position.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y) ?? null;
    node = range?.startContainer ?? null;
    within = range?.startOffset ?? 0;
  }
  if (node === null || !target.contains(node)) return null;
  // A sentence span holds one text node, so the caret offset inside it is the offset inside
  // the sentence; the block offset is that plus the sentence's own start.
  return start + Math.min(within, (target.textContent ?? '').length);
}
