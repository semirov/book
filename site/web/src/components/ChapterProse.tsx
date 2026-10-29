/**
 * The chapter's prose, block by block (BOOK-167 extraction of `ChapterArticle`'s map).
 *
 * Two things can paint a block, and only one of them at a time:
 *
 *   - `ProseParagraph` — the ordinary paragraph, as it has always been: the printing reveal,
 *     the seam's rails, the marks;
 *   - `PrintPass` — the printing renderer, mounted from an **applied print plan** (`lib/appliedPrint.ts`):
 *     the clock is `chapter:applied.appliedAt`, the places are printed **one at a time in document
 *     order** (BOOK-220 §11.2 B3 — one caret, never two), and each plan is mounted once. A settled
 *     plan is never re-keyed: the prose never replays (D5).
 *
 * BOOK-207 — nothing sits after the paragraph: the live paragraph is the whole process, and
 * a settled pass leaves the ordinary paragraph and the record's `правка` section.
 */

import type {
  BlockRevisingPayload,
  CatalogEntry,
  ChangeSummaryDto,
  ChapterDto,
  CommentDto,
  ComposerInfo,
  ViewerDto,
} from '@book/shared';
import { Fragment, useMemo, useState } from 'react';

import { reducedMotion } from '../dom.ts';
import type { PrintPlan } from '../lib/appliedPrint.ts';
import type { SeamDraft } from '../lib/draft.ts';
import { activeBlockId, blockText, type RevealState } from '../lib/reveal.ts';
import type { ParagraphChainMode } from '../useParagraphChain.ts';
import { PrintPass } from './PrintPass.tsx';
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
  /** BOOK-137: the thread's changes — a filing's number comes from its latest attempt. */
  changes?: readonly ChangeSummaryDto[];
  /**
   * BOOK-128 #3815 — the phrase's facts as the page's one chain mode: the `⋯` door and its
   * margin item belong to the paragraph, so the mode travels down rather than a page-root box.
   */
  sentence?: ParagraphChainMode;
  nowMs?: number;
  composer: ComposerInfo;
  viewer: ViewerDto;
  history: boolean;
  /** The write's print plans (§4/D2): the blocks of an applied record, already bounded. */
  prints?: readonly PrintPlan[];
  /** A plan settled: the block is an ordinary paragraph again, and that plan never replays. */
  onPrintSettled?: (key: string) => void;
  onPosted?: (comment: CommentDto) => void;
  onReanchor: (draft: SeamDraft) => void;
};

export function ChapterProse({
  entry,
  chapter,
  reveal,
  revisedIds,
  revising,
  caret,
  printing,
  comments,
  changes,
  sentence,
  nowMs,
  composer,
  viewer,
  history,
  prints = [],
  onPrintSettled,
  onPosted,
  onReanchor,
}: ChapterProseProps) {
  /** The plans whose renderer has already settled: those blocks are ordinary paragraphs again. */
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  /** When the print before this one settled: the chain's own clock, the earlier place first. */
  const [chainAt, setChainAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const reduced = reducedMotion();
  const live = useMemo(() => prints.filter((plan) => !settled.has(plan.key)), [prints, settled]);
  /**
   * BOOK-220 §11.2 B3 — **one place at a time**: only the first unsettled plan of the write has
   * a renderer, so exactly one caret exists on the page. The next opens on the settle that the
   * one before it reports (`onSettled`), never on an offset guessed before anything measured.
   */
  const head = live[0] ?? null;

  const showCaret = caret?.show === true && entry.written;
  const caretBlockId =
    reveal !== null ? (activeBlockId(reveal) ?? (showCaret ? chapter.blocks.at(-1)?.id ?? null : null)) : null;
  const revisingIds = revising !== null && revising.active ? new Set(revising.blockIds) : new Set<string>();
  /** One paint per plan: a second paragraph with the same words is not the one being written. */
  const claimed = new Set<string>();
  /** The chapter's own ids and how often each text occurs: a plan before the re-read needs both. */
  const chapterIds = new Set(chapter.blocks.map((block) => block.id));
  const textCounts = new Map<string, number>();
  for (const block of chapter.blocks) textCounts.set(block.text, (textCounts.get(block.text) ?? 0) + 1);

  return (
    <>
      {chapter.blocks.map((block, index) => {
        const text = reveal === null ? block.text : blockText(reveal, block.id, block.text);
        const revisingCause = revisingIds.has(block.id) ? (revising?.cause ?? 'draft') : null;
        // The applied print's own renderer, for this block only, and only while it is unsettled.
        // A plan carries the **post**-revision block id (`appliedPrint.ts`), so the id is the
        // key. The words are the fallback for one case only — a plan whose id the chapter does
        // not hold yet (the prose has not been re-read) — and only when that sentence stands
        // once: a twin paragraph is never painted as the block the pass wrote.
        const plan =
          head !== null &&
          !claimed.has(head.key) &&
          (head.blockId === block.id ||
            (head.blockId !== null &&
              !chapterIds.has(head.blockId) &&
              block.text === head.after &&
              textCounts.get(block.text) === 1))
            ? head
            : null;
        if (plan !== null) claimed.add(plan.key);
        return (
          <Fragment key={block.id}>
            {plan === null ? (
              <ProseParagraph
                entry={entry}
                blockId={block.id}
                blockIndex={index}
                baseRev={chapter.rev}
                text={text}
                blockCount={chapter.blocks.length}
                comments={comments}
                changes={changes}
                nowMs={nowMs}
                composer={composer}
                viewer={viewer}
                onPosted={(comment) => onPosted?.(comment)}
                sentence={sentence}
                history={history}
                onReanchor={onReanchor}
                caret={caretBlockId === block.id ? { printing, live: caret?.live === true && !printing } : null}
                revised={revisedIds.has(block.id)}
                revising={revisingCause === null ? null : revisingCause === 'cascade' ? 'правится · по замечанию' : 'правится'}
              />
            ) : (
              <PrintPass
                key={plan.key}
                blockId={block.id}
                text={plan.after}
                span={plan.span}
                startAt={chainAt.get(plan.key) ?? plan.startAt}
                reduced={reduced}
                // The pass paints the same `⋯` door the ordinary paragraph paints — hidden and
                // unreachable, so handing the block back moves no line (the door is inline).
                prov={history && sentence !== undefined}
                onSettled={() => {
                  setSettled((current) => {
                    const next = new Set(current);
                    next.add(plan.key);
                    return next;
                  });
                  // The next place of the write opens now: the chain's clock is the settle.
                  const next = live[1];
                  if (next !== undefined) {
                    const openedAt = Date.now();
                    setChainAt((current) => new Map(current).set(next.key, openedAt));
                  }
                  onPrintSettled?.(plan.key);
                }}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}
