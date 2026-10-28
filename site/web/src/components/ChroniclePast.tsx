/**
 * A past chapter in the chronicle's moment (BOOK-DOC-50 §6, BOOK-128 #3815).
 *
 * The past renders the cover, page 2 and the TOC above this file; a chapter body is fetched
 * only when the reader opens its `<details>` (`chNN@hNNN`), so scrubbing never transfers a book.
 * Every paragraph keeps the phrase's own `⋯` door, whose facts open **in flow** under the
 * paragraph: this surface has no margin channel, and a floating box over a past chapter would
 * be a second surface.
 *
 * The file is the record list's sibling rather than part of it: `Chronicle.tsx` sits on the
 * 500-line arch limit, and this pair is the one block of it that owns a read of its own.
 */

import type { HistoryChapterDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { getHistoryChapter } from '../api.ts';
import type { ParagraphChainMode } from '../useParagraphChain.ts';
import { SentenceBlock } from './SentenceBlock.tsx';

export function PastChapter({
  n,
  hseq,
  title,
  sentence,
  live,
}: {
  n: number;
  hseq: number;
  title: string | null;
  sentence: ParagraphChainMode;
  live: boolean;
}) {
  const [chapter, setChapter] = useState<HistoryChapterDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    void getHistoryChapter(n, hseq)
      .then((loaded) => {
        if (!cancelled) setChapter(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, n, hseq]);

  return (
    <details
      className="past-ch"
      onToggle={(event) => setOpened((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="past-ch-n">{String(n).padStart(2, '0')}</span>
        <span className="past-ch-title">{title ?? `глава ${n}`}</span>
      </summary>
      {failed ? <p className="chr-empty">глава не прочиталась</p> : null}
      {chapter === null && !failed ? <p className="chr-empty">глава читается…</p> : null}
      {chapter?.blocks.map((block) => (
        <PastBlock key={block.id} block={block} sentence={sentence} live={live} />
      ))}
    </details>
  );
}

/**
 * One paragraph of a past chapter, with the phrase's own `⋯` — BOOK-128 comment #3815: the facts
 * open in flow under the paragraph, and the door that opened them is where focus comes back.
 */
function PastBlock({
  block,
  sentence,
  live,
}: {
  block: { id: string; text: string };
  sentence: ParagraphChainMode;
  live: boolean;
}) {
  const door = useRef<HTMLButtonElement>(null);
  const open = live && sentence.openId === block.id;
  return (
    <div>
      <p className="p past-p" data-block-id={block.id}>
        {block.text}
        {live ? (
          <button
            type="button"
            className="prov"
            aria-label="откуда эта фраза"
            aria-expanded={open}
            ref={door}
            onClick={() => {
              // The door is the toggle and the only close this layer has.
              if (sentence.openId === block.id) {
                sentence.close();
                door.current?.focus();
                return;
              }
              sentence.open(block.id, door.current?.getBoundingClientRect() ?? new DOMRect());
            }}
          >
            ⋯
          </button>
        ) : null}
      </p>
      {open ? (
        <SentenceBlock
          chain={sentence.chain}
          loading={sentence.loading}
          failed={sentence.failed}
          quote={block.text}
          frame="none"
          place="flow"
          onRetry={sentence.retry}
          onClose={() => {
            sentence.close();
            door.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
