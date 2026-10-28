/**
 * The chapter's prose, block by block (BOOK-167 extraction of `ChapterArticle`'s map).
 *
 * Two things can paint a block, and only one of them at a time:
 *
 *   - `ProseParagraph` — the ordinary paragraph, as it has always been: the printing reveal,
 *     the seam's rails, the marks;
 *   - `LivePass` — the pass renderer, mounted for the block a `typing`/`landed` stage names,
 *     from the event's own `at`. Its spec is `passRail.ts`'s (`livePassOf` / `liveRunOf`), and
 *     it is mounted by the pass it belongs to: a new stage is a new renderer, and a settled one
 *     is never re-keyed into a replay.
 *
 * After the paragraph, in the seam's place, sits the pass strip's slot — the same block
 * position, so opening the strip moves no line box and closes nothing it does not own.
 */

import type {
  BlockRevisingPayload,
  CatalogEntry,
  ChapterDto,
  CommentDto,
  ComposerInfo,
  PassStageEvent,
  ViewerDto,
} from '@book/shared';
import { Fragment, useMemo, useState } from 'react';

import { reducedMotion } from '../dom.ts';
import type { SeamDraft } from '../lib/draft.ts';
import { livePassOf, liveRunOf } from '../lib/passRail.ts';
import { activeBlockId, blockText, type RevealState } from '../lib/reveal.ts';
import { LivePass } from './LivePass.tsx';
import { PassStripSlot } from './PassStrip.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

export type ChapterProseProps = {
  entry: CatalogEntry;
  chapter: ChapterDto;
  /** The printing reveal the chapter is running, or null when everything is already set. */
  reveal: RevealState | null;
  /** Blocks a revision marked (`BOOK-117`): the cross-fade's own set. */
  revisedIds: ReadonlySet<string>;
  revising: BlockRevisingPayload | null;
  caret: { show: boolean; live: boolean } | null;
  printing: boolean;
  comments: readonly CommentDto[];
  nowMs?: number;
  composer: ComposerInfo;
  viewer: ViewerDto;
  history: boolean;
  /** The page's stage log for this chapter: what a running pass has written so far. */
  stages?: readonly PassStageEvent[];
  onPosted?: (comment: CommentDto) => void;
  onProvenance?: (blockId: string, anchor: HTMLElement) => void;
  onReanchor: (draft: SeamDraft) => void;
};

const NO_EVENTS: readonly PassStageEvent[] = [];

export function ChapterProse({
  entry,
  chapter,
  reveal,
  revisedIds,
  revising,
  caret,
  printing,
  comments,
  nowMs,
  composer,
  viewer,
  history,
  stages,
  onPosted,
  onProvenance,
  onReanchor,
}: ChapterProseProps) {
  /** The pass whose renderer has already settled: its block is an ordinary paragraph again. */
  const [settled, setSettled] = useState<string | null>(null);
  const reduced = reducedMotion();
  const spec = useMemo(() => livePassOf(stages ?? NO_EVENTS), [stages]);

  const showCaret = caret?.show === true && entry.written;
  const caretBlockId =
    reveal !== null ? (activeBlockId(reveal) ?? (showCaret ? chapter.blocks.at(-1)?.id ?? null : null)) : null;
  const revisingIds = revising !== null && revising.active ? new Set(revising.blockIds) : new Set<string>();
  /** BOOK-156: `#pass` is the live pass's first line; only a live revising block carries it. */
  const passBlockId = revising !== null && revising.active ? (revising.blockIds[0] ?? null) : null;
  const section = stages ?? NO_EVENTS;
  /** One paint per pass: a second paragraph with the same words is not the one being written. */
  let painted = false;

  return (
    <>
      {chapter.blocks.map((block, index) => {
        const text = reveal === null ? block.text : blockText(reveal, block.id, block.text);
        const revisingCause = revisingIds.has(block.id) ? (revising?.cause ?? 'draft') : null;
        // The pass's own renderer, for this block only, and only while it is unsettled.
        const run = spec === null || spec.key === settled || painted ? null : liveRunOf(spec, block);
        if (run !== null) painted = true;
        return (
          <Fragment key={block.id}>
            {passBlockId === block.id ? <span id="pass" data-pass-block={block.id} aria-hidden="true" /> : null}
            {run === null || spec === null ? (
              <ProseParagraph
                entry={entry}
                blockId={block.id}
                blockIndex={index}
                baseRev={chapter.rev}
                text={text}
                blockCount={chapter.blocks.length}
                comments={comments}
                nowMs={nowMs}
                composer={composer}
                viewer={viewer}
                onPosted={(comment) => onPosted?.(comment)}
                onBlockProvenance={onProvenance}
                history={history}
                onReanchor={onReanchor}
                caret={caretBlockId === block.id ? { printing, live: caret?.live === true && !printing } : null}
                revised={revisedIds.has(block.id)}
                revising={revisingCause === null ? null : revisingCause === 'cascade' ? 'правится · по замечанию' : 'правится'}
              />
            ) : (
              <LivePass
                key={spec.key}
                blockId={block.id}
                text={run.text}
                span={run.span}
                startAt={spec.startAt}
                reduced={reduced}
                onSettled={() => setSettled(spec.key)}
              />
            )}
            <PassStripSlot
              chapter={entry.n}
              blockId={block.id}
              events={section}
              blocks={chapter.blocks}
              last={index === chapter.blocks.length - 1}
            />
          </Fragment>
        );
      })}
    </>
  );
}
