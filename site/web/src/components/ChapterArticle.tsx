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
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { getChapter } from '../api.ts';
import { nearViewport, reducedMotion } from '../dom.ts';
import { basisSentenceOf, chapterMatchesEntry } from '../lib/basis.ts';
import { reserveHeight } from '../lib/cssom.ts';
import { estimateChapterHeight } from '../lib/layout.ts';
import { CHAPTER_BOX_PX, statusLine } from '../lib/skeleton.ts';
import { applyPatch, revisedBlockIds } from '../lib/patch.ts';
import { isFrozenChapter } from '../lib/freeze.ts';
import { rekeyDraft, seamDrafts, type SeamDraft } from '../lib/draft.ts';
import { reanchorAnchor, seamKey } from '../lib/seam.ts';
import { openSeam, useOpenSeam } from '../lib/useSeam.ts';
import { usePending } from '../usePending.ts';
import { ChapterHeader } from './ChapterHeader.tsx';
import { PremiseEntry } from './PremiseEntry.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';
import { Skeleton } from './Skeleton.tsx';
import {
  REVEAL,
  activeBlockId,
  blockText,
  createReveal,
  finishReveal,
  planReveal,
  revealComplete,
  skipBlocks,
  tickReveal,
  type RevealState,
} from '../lib/reveal.ts';

/**
 * One chapter slot (ARCHITECTURE §11.2, §11.3, §11.5):
 *
 * - the header comes from the catalog on the first paint, the prose on scroll;
 * - new text prints at 18 cps, block by block, only in the viewport; everything else is
 *   already set (ADR-006 — the server never streams tokens);
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
  /** «⋯ откуда эта фраза» (§11.10): the paragraph's lineage chain, anchored on the button. */
  onProvenance?: (blockId: string, anchor: HTMLElement) => void;
  /** BOOK-DOC-34: this chapter's filings, loaded lazily on the same trigger as the prose. */
  comments?: readonly CommentDto[];
  /**
   * BOOK-137: the thread's changes — the attempts a filing carries. The premise's row names
   * the latest one, so a change is never a second row beside its filing.
   */
  changes?: readonly ChangeSummaryDto[];
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
};

export function ChapterArticle({
  entry,
  revision,
  revising,
  caret,
  fresh,
  onProvenance,
  comments = [],
  changes = [],
  onRead,
  onPosted,
  composer,
  viewer,
  history,
  firstEmpty = false,
}: ChapterArticleProps) {
  const seam = useOpenSeam();
  /**
   * BOOK-33 — a stale draft waiting for the fresh revision. The draft keeps what the reader
   * wrote; its block and base revision are replaced here, after the chapter reloads.
   */
  const [reanchor, setReanchor] = useState<{ draft: SeamDraft; blockGone: boolean } | null>(null);
  const [chapter, setChapter] = useState<ChapterDto | null>(null);
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [revisedIds, setRevisedIds] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(false);
  const article = useRef<HTMLElement | null>(null);
  const loading = useRef(false);
  const measured = useRef(false);
  const speed = useRef(1);

  const printing = reveal !== null && !revealComplete(reveal);
  /** A basis slot carries text too, but it is not a written chapter (§BOOK-6). */
  const showsText = entry.written || entry.basis;
  const basisSentence = basisSentenceOf(entry);
  /**
   * BOOK-DOC-43 §4 — the wait is real from the fetch until it settles, data or failure, and
   * derived from state (a settle re-renders). A basis slot is complete before the request, so
   * it waits silently: no status and no busy claim for text already on screen.
   */
  const busy = showsText && inView && chapter === null && !failed && basisSentence === null;
  const stage = usePending(busy);
  const startReveal = useCallback((loaded: ChapterDto) => {
    const reduce = reducedMotion();
    const ageMs = Number.isNaN(Date.parse(loaded.writtenAt)) ? 0 : Date.now() - Date.parse(loaded.writtenAt);
    const plan = planReveal({
      blocks: loaded.blocks,
      mode: fresh ? 'live' : 'join',
      chapterAgeMs: Math.max(0, ageMs),
      reducedMotion: reduce,
    });
    const queued = loaded.blocks.filter((block) => plan.queued.includes(block.id));
    setReveal(createReveal(queued, { reducedMotion: reduce }));
    measured.current = false;
  }, [fresh]);

  const load = useCallback(async () => {
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
      startReveal(result);
    } catch {
      setFailed(true);
    } finally {
      loading.current = false;
    }
  }, [entry.n, startReveal]);

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
      void load();
      return;
    }
    // A chapter emptied down to its basis sentence keeps `rev`: the projection is not a
    // revision, so the loading slot must drop the prose it still holds (§BOOK-6).
    if (chapterMatchesEntry(entry, chapter)) return;

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
        setRevisedIds(new Set(revisedBlockIds(revision.patch)));
        // A rewrite cross-fades; it never re-types. If text was still printing, stop.
        setReveal((current) => (current === null ? current : finishReveal(current)));
        return;
      }
    }
    void load();
  }, [chapter, entry, showsText, inView, load, revision]);

  // One animation loop while the queue prints; it stops when the queue is empty.
  useEffect(() => {
    if (!printing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const delta = Math.min(250, now - last);
      last = now;
      setReveal((current) => (current === null ? current : tickReveal(current, delta, speed.current)));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [printing]);

  // Scrolling away drains the queue at 8× rather than holding a chapter hostage.
  useEffect(() => {
    const update = (): void => {
      const node = article.current;
      speed.current = node !== null && !nearViewport(node, 0.5) ? REVEAL.offscreenSpeedUp : 1;
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // Only blocks inside the reveal window print; after the first paint the rest is set.
  useEffect(() => {
    if (chapter === null || reveal === null || measured.current) return;
    measured.current = true;
    const node = article.current;
    if (node === null) return;
    const height = window.innerHeight || 800;
    const skipped = new Set<string>();
    for (const element of node.querySelectorAll('[data-block-id]')) {
      const id = element.getAttribute('data-block-id');
      if (id === null) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom < -1.5 * height || rect.top > 2.5 * height) skipped.add(id);
    }
    if (skipped.size > 0) setReveal((current) => (current === null ? current : skipBlocks(current, skipped)));
  }, [chapter, reveal]);

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

  const showCaret = caret?.show === true && chapter !== null && entry.written;
  const caretBlockId = reveal !== null ? (activeBlockId(reveal) ?? (showCaret ? chapter?.blocks.at(-1)?.id ?? null : null)) : null;
  const revisingIds = revising !== null && revising.active ? new Set(revising.blockIds) : new Set<string>();
  /** §6: `null` while the wait is quiet — the header then prints what it prints today. */
  const status = statusLine('chapter', stage, entry.n);

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
        ref={article}
      >
        <PremiseEntry
          entry={entry}
          comments={comments}
          changes={changes}
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
      aria-busy={busy ? 'true' : undefined}
    >
      {header}
      {entry.title !== null ? (
        <h3 className="ch-title fade-in" key={`title-${entry.rev}-${entry.title}`}>
          {entry.title}
        </h3>
      ) : null}

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
          composer={composer}
          viewer={viewer}
          firstEmpty={false}
          onPosted={onPosted}
        />
      ) : null}

      {chapter !== null
        ? chapter.blocks.map((block, index) => {
            const text = reveal === null ? block.text : blockText(reveal, block.id, block.text);
            const revisingCause = revisingIds.has(block.id) ? (revising?.cause ?? 'draft') : null;
            return (
              <Fragment key={block.id}>
                <ProseParagraph
                  entry={entry}
                  blockId={block.id}
                  blockIndex={index}
                  baseRev={chapter.rev}
                  text={text}
                  frozen={isFrozenChapter(entry)}
                  comments={comments}
                  composer={composer}
                  viewer={viewer}
                  onPosted={(comment) => onPosted?.(comment)}
                  onBlockProvenance={onProvenance}
                  history={history}
                  onReanchor={(draft) => {
                    setReanchor({ draft, blockGone: false });
                    void load();
                  }}
                  caret={
                    caretBlockId === block.id
                      ? { printing, live: caret?.live === true && !printing }
                      : null
                  }
                  revised={revisedIds.has(block.id)}
                  revising={revisingCause === null ? null : revisingCause === 'cascade' ? 'правится · по замечанию' : 'правится'}
                />
              </Fragment>
            );
          })
        : null}

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
          frozen
          comments={comments}
          composer={composer}
          viewer={viewer}
          onPosted={(comment) => onPosted?.(comment)}
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
          {stage === 'quiet' ? null : <Skeleton variant="chapter" />}
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
