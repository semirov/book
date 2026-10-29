import {
  type BlockRevisingPayload,
  type CatalogEntry,
  type ChangeSummaryDto,
  type ChapterDto,
  type ChapterRevisionPayload,
  type CommentDto,
  type ComposerInfo,
  type ViewerDto,
} from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getChapter } from '../api.ts';
import { reducedMotion } from '../dom.ts';
import { basisSentenceOf, chapterMatchesEntry } from '../lib/basis.ts';
import { reserveHeight } from '../lib/cssom.ts';
import { estimateChapterHeight } from '../lib/layout.ts';
import { CHAPTER_BOX_PX, statusLine } from '../lib/skeleton.ts';
import { printWindowOpen, type AppliedRecord } from '../lib/appliedPrint.ts';
import { applyPatch, revisedBlockIds } from '../lib/patch.ts';
import { rekeyDraft, seamDrafts, type SeamDraft } from '../lib/draft.ts';
import { useAppliedPrint } from '../lib/useAppliedPrint.ts';
import type { ParagraphChainMode } from '../useParagraphChain.ts';
import { reanchorAnchor, seamKey } from '../lib/seam.ts';
import { openSeam, useOpenSeam } from '../lib/useSeam.ts';
import { usePending } from '../usePending.ts';
import { usePrintingReveal } from '../lib/usePrintingReveal.ts';
import { createReveal, finishReveal, printsChange, revealCps } from '../lib/reveal.ts';
import { ChapterHeader } from './ChapterHeader.tsx';
import { ChapterProse } from './ChapterProse.tsx';
import { PremiseEntry } from './PremiseEntry.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';
import { Skeleton } from './Skeleton.tsx';

/**
 * One chapter slot (ARCHITECTURE §11.2, §11.3, §11.5):
 *
 * - the header comes from the catalog on the first paint, the prose on scroll;
 * - new text prints on the print engine's clock (30 cps desk / 26 phone, BOOK-220 §11.2),
 *   block by block, only in the viewport; everything else is already set (ADR-006 — the server
 *   never streams tokens);
 * - a revision is applied by `rev`; a rewrite cross-fades, it never re-types old text;
 * - the caret sits after the block being printed, or after the last block of the lane's
 *   chapter; a cascade moves no caret;
 * - blocks named by `block:revising` carry the ochre rule, not the whole chapter;
 * - a basis-only slot (ch01/ch67) is read like a chapter of one paragraph and is still not
 *   written: it prints its frozen frame, never the «не написана» label (BOOK-6).
 */
export type ChapterArticleProps = {
  entry: CatalogEntry;
  revision: ChapterRevisionPayload | null;
  revising: BlockRevisingPayload | null;
  /** The lane's caret is in this chapter; `live` blinks only for a drafting lane. */
  caret: { show: boolean; live: boolean } | null;
  /** This chapter arrived while the reader was here: print its opening. */
  fresh: boolean;
  /**
   * «⋯ откуда эта фраза» (§11.10) — BOOK-128 comment #3815: the chain is the paragraph's own
   * margin item, so the mode travels to every paragraph instead of a floating page-root box.
   */
  sentence?: ParagraphChainMode;
  /** BOOK-DOC-34: this chapter's filings, loaded lazily on the same trigger as the prose. */
  comments?: readonly CommentDto[];
  /**
   * BOOK-137: the thread's changes — the attempts a filing carries. The premise's row names
   * the latest one, so a change is never a second row beside its filing.
   */
  changes?: readonly ChangeSummaryDto[];
  /** BOOK-158: the page's revise clock, handed to the premise row and the card. */
  nowMs?: number;
  /** The chapter's filings were asked for when its slot came into view. */
  onRead?: (chapter: number) => void;
  /** A filing was posted in this chapter: its DTO reaches the page, then the register. */
  onPosted?: (comment: CommentDto) => void;
  composer: ComposerInfo;
  viewer: ViewerDto;
  /** BOOK-56: `state.history.live` — off drops the chain door and the DNA rows, not the text. */
  history: boolean;
  /** The first empty chapter in the flow carries the page's one explanation sentence. */
  firstEmpty?: boolean;
  /**
   * BOOK-DOC-84 §4/D2 — the write this chapter just received (`chapter:applied`, or
   * `live.applied` on a fresh page). It is the print's only clock: the article plans the ink
   * from its `appliedAt`, for the blocks inside 1.5 viewports, and mounts `LivePass` for them.
   */
  applied?: AppliedRecord | null;
};

export function ChapterArticle({
  entry,
  revision,
  revising,
  caret,
  fresh,
  sentence,
  comments = [],
  changes = [],
  nowMs,
  onRead,
  onPosted,
  composer,
  viewer,
  history,
  firstEmpty = false,
  applied = null,
}: ChapterArticleProps) {
  const seam = useOpenSeam();
  /**
   * BOOK-33 — a stale draft waiting for the fresh revision. The draft keeps what the reader
   * wrote; its block and base revision are replaced here, after the chapter reloads.
   */
  const [reanchor, setReanchor] = useState<{ draft: SeamDraft; blockGone: boolean } | null>(null);
  const [chapter, setChapter] = useState<ChapterDto | null>(null);
  const [revisedIds, setRevisedIds] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(false);
  const loading = useRef(false);
  const printingReveal = usePrintingReveal({ chapter, fresh });
  const { article, reveal, setReveal, printing, line, startReveal } = printingReveal;
  /** BOOK-117: the change behind a revision, held across the refetch it forces. */
  const changeIds = useRef<ReadonlySet<string> | null>(null);
  /**
   * BOOK-220 §11.2 — the write this chapter is *receiving right now*: its `appliedAt` is the
   * print's clock, and a created chapter has no prose on the page yet, so the slot fetches it
   * and prints from that moment instead of restarting at zero.
   */
  const appliedHere = applied !== null && applied.n === entry.n && printWindowOpen(applied, Date.now());
  /** The print's own start: `appliedAt` while the write is inside its window, else none. */
  const printClock = appliedHere ? applied.appliedAt : undefined;


  /** A basis slot carries text too, but it is not a written chapter (§BOOK-6). */
  const showsText = entry.written || entry.basis || appliedHere;
  const basisSentence = basisSentenceOf(entry, chapter);
  /**
   * BOOK-DOC-43 §4 — the wait is real from the fetch until it settles, data or failure, and
   * derived from state (a settle re-renders). A basis slot is complete before the request, so
   * it waits silently: no status and no busy claim for text already on screen.
   */
  const busy = showsText && inView && chapter === null && !failed && basisSentence === null;
  const stage = usePending(busy);
  const load = useCallback(async (clock?: number) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const result = await getChapter(entry.n);
      if (result === null) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setChapter(result);
      // BOOK-117 / D2: the refetch prints the reader's own change that travelled with the
      // request, and never a pass landing — a write is printed only by an applied record.
      const changed = changeIds.current;
      changeIds.current = null;
      // BOOK-220 §11.2 — a chapter being written has one clock: `appliedAt`. A page load has
      // none, and only a young chapter's tail prints there.
      startReveal(result, changed, clock);
    } catch {
      setFailed(true);
    } finally {
      loading.current = false;
    }
  }, [entry.n, startReveal]);

  /** The write's print plans (BOOK-DOC-84 §4/D2, BOOK-220 §11.2): one place at a time. */
  const prints = useAppliedPrint({ applied, n: entry.n, article, loaded: chapter !== null, load });

  // Load when the slot comes within 1.5 viewports (mobile-first: a 45 KB chapter is not
  // fetched until it is nearly on screen).
  // BOOK-DOC-34 §6: the filings arrive with the prose, not before it.
  useEffect(() => {
    const node = article.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          onRead?.(entry.n);
          observer.disconnect();
        }
      },
      { rootMargin: '150% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [entry.n, onRead]);

  useEffect(() => {
    if (!showsText) return;
    const node = article.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '150% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [entry.n, showsText]);

  // Apply or refetch on a revision. `rev` is the only ordering authority (§10.4).
  useEffect(() => {
    if (!showsText || !inView) return;
    if (chapter === null) {
      void load(printClock);
      return;
    }
    // A chapter emptied down to its basis sentence keeps `rev`: the projection is not a
    // revision, so the loading slot must drop the prose it still holds (§BOOK-6).
    if (chapterMatchesEntry(entry, chapter)) return;
    // BOOK-220 §11.2 — a chapter *ahead* of the catalog is the newer truth: this page just
    // printed a write whose catalog row has not caught up (`refreshCatalog` follows). Only a
    // newer catalog row, or a different basis shape, means the prose we hold is stale.
    if (chapter.rev > entry.rev && chapter.basis === entry.basis) return;

    if (
      revision !== null &&
      revision.n === entry.n &&
      revision.rev === chapter.rev + 1 &&
      !revision.patchTruncated
    ) {
      const patched = applyPatch(chapter.blocks, revision.patch);
      if (patched !== null) {
        setChapter({
          ...chapter,
          title: revision.title,
          rev: revision.rev,
          chars: revision.chars,
          updatedAt: revision.updatedAt,
          blocks: patched,
        });
        if (!printsChange(revision)) {
          setRevisedIds(new Set(revisedBlockIds(revision.patch)));
          // A machine rewrite cross-fades; it never re-types. If text was printing, stop.
          setReveal((current) => (current === null ? current : finishReveal(current)));
          return;
        }
        // BOOK-117: a change the reader made is *seen being written*: its blocks print.
        const change = revisedBlockIds(revision.patch);
        setRevisedIds(new Set());
        line.current = change[0] ?? null;
        setReveal(
          createReveal(patched.filter((block) => change.includes(block.id)), {
            reducedMotion: reducedMotion(),
            cps: revealCps(typeof window === 'undefined' ? 390 : window.innerWidth),
          }),
        );
        printingReveal.startReveal; // the hook owns `measured`; the change prints where it is
        return;
      }
    }
    // A patch this client cannot apply is refetched; the change behind it travels with the
    // request, so the refetched text still prints instead of appearing whole.
    if (
      revision !== null &&
      revision.n === entry.n &&
      revision.rev > chapter.rev &&
      printsChange(revision)
    ) {
      changeIds.current = new Set(revisedBlockIds(revision.patch));
    }
    void load();
  }, [chapter, entry, printClock, showsText, inView, load, revision]);

  // The reload that a stale send asks for is the moment to re-key the draft: the new block
  // id, sentence and revision come from the chapter that just arrived (BOOK-33).
  useEffect(() => {
    if (reanchor === null || chapter === null || reanchor.blockGone) return;
    // The reload has not landed yet: re-keying onto the same revision would repeat the failure.
    if (chapter.rev === reanchor.draft.baseRev) return;
    // The paragraph may have been rewritten into a new block: find it by id, then by the
    // position it held when the reader opened the seam (the reviewer's «new block» case).
    const block =
      chapter.blocks.find((item) => item.id === reanchor.draft.blockId) ??
      chapter.blocks[reanchor.draft.blockIndex ?? -1];
    if (block === undefined) {
      setReanchor({ draft: reanchor.draft, blockGone: true });
      return;
    }
    const anchor = reanchorAnchor({
      text: block.text,
      blockId: block.id,
      baseRev: chapter.rev,
      previous: seam?.anchor ?? null,
    });
    if (anchor === null) {
      setReanchor({ draft: reanchor.draft, blockGone: true });
      return;
    }
    const key = seamKey(entry.n, block.id, anchor.sentence, chapter.rev);
    const moved = rekeyDraft(reanchor.draft, {
      blockId: block.id,
      sentence: anchor.quote,
      baseRev: chapter.rev,
      blockIndex: chapter.blocks.indexOf(block),
    });
    if (seam !== null) seamDrafts.drop(seam.key);
    seamDrafts.keep(key, moved);
    openSeam({ chapter: entry.n, blockId: block.id, key, anchor, origin: seam?.origin ?? null });
    setReanchor(null);
  }, [chapter, entry.n, reanchor, seam]);

  /**
   * §6: `null` while the wait is quiet — and `null` while the chapter is being written: the
   * slot is about to print its prose, so the wait sentence would be a second, false state.
   */
  const printPending = appliedHere && chapter === null;
  const status = printPending ? null : statusLine('chapter', stage, entry.n);
  /** The head's title: the catalog's, else the chapter's own (a chapter just created). */
  const title = entry.title ?? chapter?.title ?? null;

  const header = <ChapterHeader entry={entry} printing={printing} status={status} basisSentence={basisSentence} />;

  if (!showsText) {
    // BOOK-90 A: an empty chapter is one row in the flow — no `ch-h`, no big numeral, no meta
    // line; its premise strip is a block after the row, never over a line. The `<article>` is
    // the same element the written branch renders, so the slot survives the empty → written
    // swap and its observer keeps watching a live node.
    return (
      <article
        className="page ch ch-empty"
        id={`ch-${entry.n}`}
        data-n={entry.n}
        data-rev={0}
        aria-label={`глава ${entry.n}`}
        tabIndex={-1}
        ref={article}
      >
        <PremiseEntry
          entry={entry}
          comments={comments}
          changes={changes}
          nowMs={nowMs}
          composer={composer}
          viewer={viewer}
          firstEmpty={firstEmpty}
          form
          onPosted={onPosted}
        />
      </article>
    );
  }

  return (
    <article
      className={`page ch${printing ? ' is-printing' : ''}`}
      id={`ch-${entry.n}`}
      data-n={entry.n}
      data-rev={entry.rev}
      data-basis={entry.basis ? 'true' : undefined}
      ref={article}
      aria-label={`глава ${entry.n}`}
      tabIndex={-1}
      aria-busy={busy ? 'true' : undefined}
    >
      {header}
      {title === null ? null : (
        <h3 className="ch-title" key={`title-${entry.rev}-${title}`}>
          {title}
        </h3>
      )}

      {/*
        BOOK-137 — a written chapter keeps its premise's one entry. The filing must not move
        house when the text arrives: the row above the prose is where the reader finds the
        premise, its state and the number of its latest attempt, and the thread never lists it.
      */}
      {entry.written && !entry.basis ? (
        <PremiseEntry
          entry={entry}
          comments={comments}
          changes={changes}
          nowMs={nowMs}
          composer={composer}
          viewer={viewer}
          firstEmpty={false}
          onPosted={onPosted}
        />
      ) : null}

      {chapter !== null ? (
        <ChapterProse
          entry={entry}
          chapter={chapter}
          reveal={reveal}
          revisedIds={revisedIds}
          revising={revising}
          caret={caret}
          printing={printing}
          comments={comments}
          changes={changes}
          sentence={sentence}
          nowMs={nowMs}
          composer={composer}
          viewer={viewer}
          history={history}
          prints={prints}
          onPosted={onPosted}
          onReanchor={(draft) => {
            setReanchor({ draft, blockGone: false });
            void load();
          }}
        />
      ) : null}

      {chapter === null && basisSentence !== null ? (
        // A basis slot is complete before the request: the frozen frame is one shared
        // constant, and the request only adds the paragraph's id and revision (§BOOK-6).
        // The article, not this paragraph, carries `data-basis`: it survives the load.
        <ProseParagraph
          entry={entry}
          blockId={`ch${String(entry.n).padStart(2, '0')}#frame`}
          blockIndex={0}
          baseRev={0}
          text={basisSentence}
          blockCount={1}
          comments={comments}
          changes={changes}
          nowMs={nowMs}
          composer={composer}
          viewer={viewer}
          onPosted={(comment) => onPosted?.(comment)}
          sentence={sentence}
          history={history}
        />
      ) : null}

      {chapter === null && basisSentence === null && !failed ? (
        // BOOK-30: the reserved height goes through CSSOM (`reserveHeight`) so the markup
        // carries no style attribute; the ref runs in the same commit, before paint.
        // BOOK-DOC-43 §3: the form lives INSIDE this reserved box and sets no height of its
        // own, so the placeholder adds 0 px to the page.
        <div
          className="ch-placeholder"
          ref={(node) => {
            reserveHeight(node, Math.max(estimateChapterHeight(entry.chars, window.innerWidth || 390), CHAPTER_BOX_PX));
          }}
          aria-hidden="true"
        >
          {/* BOOK-220 §11.2: a chapter being written has no bars — the prose is coming, and
              the head already says the number and the title. */}
          {stage === 'quiet' || printPending ? null : <Skeleton variant="chapter" />}
        </div>
      ) : null}

      {reanchor?.blockGone === true ? (
        <div className="seam seam-missing" role="status">
          <p className="seam-note">этого абзаца больше нет — черновик сохранён</p>
          <button
            type="button"
            className="seam-cta"
            onClick={() => {
              // Attach to the paragraph's current place: the chapter's first block, if any.
              const block = chapter?.blocks[0];
              const draft = reanchor.draft;
              setReanchor(null);
              if (block === undefined) return;
              const anchor = reanchorAnchor({ text: block.text, blockId: block.id, baseRev: chapter?.rev ?? 0, previous: null });
              if (anchor === null) return;
              const key = seamKey(entry.n, block.id, anchor.sentence, chapter?.rev ?? 0);
              seamDrafts.keep(key, rekeyDraft(draft, { blockId: block.id, sentence: anchor.quote, baseRev: chapter?.rev ?? 0 }));
              openSeam({ chapter: entry.n, blockId: block.id, key, anchor, origin: null });
            }}
          >
            прикрепить к этому месту
          </button>
        </div>
      ) : null}

      {failed ? (
        <div className="ch-fail">
          <span>глава не загрузилась</span>
          <button type="button" onClick={() => void load()}>
            повторить
          </button>
        </div>
      ) : null}

      {printing ? (
        <button className="show-now" type="button" onClick={() => setReveal((current) => (current === null ? current : finishReveal(current)))}>
          показать сразу
        </button>
      ) : null}
    </article>
  );
}
