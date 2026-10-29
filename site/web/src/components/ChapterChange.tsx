import type { CommentDto } from '@book/shared';
import { useEffect } from 'react';

import { useChangeRead } from '../lib/changeCache.ts';
import { changeNumber } from '../lib/changeStatus.ts';
import { changeBefore } from '../lib/changeView.ts';
import { closeChapterChange, useChapterChange } from '../lib/record.ts';
import { clearChangeParam } from '../lib/changeLink.ts';
import { ChangeSection } from './ChangeSection.tsx';

/**
 * A change with no sentence: the chapter's own row.
 *
 * A premise, an author's own change, a filing whose paragraph the log says is gone — none of
 * them has a sentence a record could stand on. The chapter prints the change's section in the
 * flow after its premise row: the same rows, the same register, the numeral as the header value
 * and one close. Nothing here is a dialog, a sheet or a layer over the page.
 */
export function ChapterChange({ chapter, comments }: { chapter: number; comments: readonly CommentDto[] }) {
  const current = useChapterChange();
  const here = current !== null && current.chapter === chapter;
  const read = useChangeRead(here ? current.changeId : null, here);

  useEffect(() => {
    if (!here) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      closeChapterChange();
      clearChangeParam();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [here]);

  if (!here) return null;

  const close = (): void => {
    closeChapterChange();
    clearChangeParam();
  };

  return (
    <section className="rec-chapter-change ym-hide-content" aria-label={read.change === null ? 'правка' : `правка ${changeNumber(read.change.seq)}`}>
      <div className="rec-chapter-change-h">
        <span className="rec-section-label">правка</span>
        {read.change === null ? null : <span className="rec-section-count">{changeNumber(read.change.seq)}</span>}
        <button type="button" className="rec-change-close" onClick={close} aria-label="закрыть">
          ✕
        </button>
      </div>
      {read.failed ? (
        <p className="rec-line rec-quiet">правка не прочиталась</p>
      ) : read.change === null ? (
        <p className="rec-line rec-quiet">правка читается</p>
      ) : (
        <ChangeSection change={read.change} before={changeBefore(read.change, comments)} after={null} />
      )}
    </section>
  );
}
