import {
  chapterLabel,
  type BlockRevisingPayload,
  type CatalogEntry,
  type ChapterDto,
  type ChapterRevisionPayload,
} from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getChapter } from '../api.ts';
import { nearViewport, reducedMotion } from '../dom.ts';
import { basisSentenceOf, chapterMatchesEntry } from '../lib/basis.ts';
import { formatChars, formatTime } from '../lib/format.ts';
import { estimateChapterHeight } from '../lib/layout.ts';
import { applyPatch, revisedBlockIds } from '../lib/patch.ts';
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
  /** «⋯ откуда эта фраза» (§11.10): the paragraph's lineage chain. */
  onProvenance?: (blockId: string) => void;
};

export function ChapterArticle({ entry, revision, revising, caret, fresh, onProvenance }: ChapterArticleProps) {
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

  const showCaret = caret?.show === true && chapter !== null && entry.written;
  const caretBlockId = reveal !== null ? (activeBlockId(reveal) ?? (showCaret ? chapter?.blocks.at(-1)?.id ?? null : null)) : null;
  const revisingIds = revising !== null && revising.active ? new Set(revising.blockIds) : new Set<string>();

  const header = (
    <header className="ch-h">
      <span className="ch-id">
        {entry.direction === 'backward' ? (
          <span className="dir" aria-hidden="true">
            ←
          </span>
        ) : null}
        <h2 className="ch-n" aria-hidden="true">
          {chapterLabel(entry.n)}
        </h2>
      </span>
      <span className="ch-meta">
        {printing ? '■ печатается · ' : ''}
        {entry.written
          ? `${formatChars(entry.chars)} · ${formatTime(entry.updatedAt)}`
          : basisSentence === null
            ? 'не написана'
            : null}
      </span>
    </header>
  );

  if (!showsText) {
    return (
      <article className="page ch ch-empty" id={`ch-${entry.n}`} data-n={entry.n} data-rev={0} aria-label={`глава ${entry.n}`}>
        {header}
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
      aria-busy={chapter === null && !failed}
    >
      {header}
      {entry.title !== null ? (
        <h3 className="ch-title fade-in" key={`title-${entry.rev}-${entry.title}`}>
          {entry.title}
        </h3>
      ) : null}

      {chapter !== null
        ? chapter.blocks.map((block) => {
            const text = reveal === null ? block.text : blockText(reveal, block.id, block.text);
            const revisingCause = revisingIds.has(block.id) ? (revising?.cause ?? 'draft') : null;
            const classes = ['p'];
            if (printing && caretBlockId === block.id) classes.push('is-printing');
            if (revisingCause !== null) classes.push('is-revising');
            if (revisedIds.has(block.id)) classes.push('is-revised');
            return (
              <p
                className={classes.join(' ')}
                key={block.id}
                data-block-id={block.id}
                data-revising={revisingCause ?? undefined}
                data-change={revisingCause !== null ? (revising?.changeId ?? undefined) : undefined}
              >
                {revisingCause !== null ? (
                  <span className="revising-label">
                    {revisingCause === 'cascade' ? 'правится · по замечанию' : 'правится'}
                  </span>
                ) : null}
                {text}
                {onProvenance === undefined ? null : (
                  <button
                    type="button"
                    className="prov"
                    aria-label="откуда эта фраза"
                    onClick={() => onProvenance(block.id)}
                  >
                    ⋯
                  </button>
                )}
                {caretBlockId === block.id ? (
                  <span
                    className={`caret-inline${caret?.live === true && !printing ? ' blink' : ''}${printing ? '' : ' resting'}`}
                    aria-hidden="true"
                  />
                ) : null}
              </p>
            );
          })
        : null}

      {chapter === null && basisSentence !== null ? (
        // A basis slot is complete before the request: the frozen frame is one shared
        // constant, and the request only adds the paragraph's id and revision (§BOOK-6).
        // The article, not this paragraph, carries `data-basis`: it survives the load.
        <p className="p">{basisSentence}</p>
      ) : null}

      {chapter === null && basisSentence === null && !failed ? (
        <div
          className="ch-placeholder"
          style={{ minHeight: estimateChapterHeight(entry.chars, window.innerWidth || 390) }}
          aria-hidden="true"
        />
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
