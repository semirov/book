import type { CatalogEntry, ComposerInfo, CommentDto, ViewerDto } from '@book/shared';
import type { RefObject } from 'react';

import { closeRecord, recordKey, type OpenRecord } from '../lib/record.ts';
import type { SeamDraft } from '../lib/draft.ts';

import { Record } from './Record.tsx';

/**
 * BOOK-128 comment #3852 — the page's one block, drawn by the paragraph it belongs to.
 *
 * The slot exists for one reason: `Record` is mounted only while the store names this paragraph
 * and this range, and the close hands focus back to the mark (`[data-touch]`) with
 * `preventScroll` — never to the page, never by scrolling the reader's line away. The key is
 * the range, so another span is another node in the same commit: one block, no closing ghost.
 */
export function RecordSlot({
  record,
  entry,
  blockId,
  blockIndex,
  baseRev,
  frozen,
  writing,
  filings,
  composer,
  viewer,
  history,
  hostRef,
  onPosted,
  onReanchor,
}: {
  record: OpenRecord;
  entry: CatalogEntry;
  blockId: string;
  blockIndex: number;
  baseRev: number;
  frozen: 'frame' | 'basis' | null;
  /** The sentence's filings in reading order; the record sorts and folds them. */
  filings: CommentDto[] | null;
  composer: ComposerInfo;
  viewer: ViewerDto;
  history: boolean;
  hostRef: RefObject<HTMLElement | null>;
  /** A pass is writing this paragraph now. */
  writing: boolean;
  onPosted: (comment: CommentDto) => void;
  onReanchor?: (draft: SeamDraft) => void;
}) {
  return (
    <Record
      key={recordKey(record)}
      entry={entry}
      blockId={blockId}
      blockIndex={blockIndex}
      baseRev={baseRev}
      start={record.start}
      end={record.end}
      word={record.word ?? null}
      frozen={frozen}
      writing={writing}
      anchor={record.anchor}
      filings={filings}
      composer={composer}
      viewer={viewer}
      history={history}
      onPosted={onPosted}
      {...(onReanchor === undefined ? {} : { onReanchor })}
      onClose={() => {
        closeRecord();
        // The trigger comes back: the span a touch opened, the `⋯` a keyboard used. The
        // paragraph itself is not a target — a reader is never dropped mid-line.
        const origin = record.origin !== null && record.origin.isConnected ? record.origin : null;
        const trigger = origin?.matches('.prov, [data-touch], [data-s]') === true ? origin : null;
        const back = trigger ?? hostRef.current?.querySelector<HTMLElement>('[data-touch]') ?? origin;
        back?.focus({ preventScroll: true });
      }}
    />
  );
}
