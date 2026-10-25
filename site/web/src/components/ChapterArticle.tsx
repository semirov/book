import { chapterLabel, type CatalogEntry, type ChapterDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { getChapter } from '../api.ts';
import { formatChars, formatTime } from '../lib/format.ts';
import { estimateChapterHeight } from '../lib/layout.ts';

const CHAPTER_PREFETCH = '150% 0px';

/**
 * One chapter slot. The header is drawn from the catalog immediately; the prose is
 * fetched when the chapter comes within 1.5 viewports (DESIGN §11.2, ADR-006), so the
 * page stays cheap while the book grows. Printing is M2: the text appears at rest.
 */
export function ChapterArticle({ entry }: { entry: CatalogEntry }) {
  const [chapter, setChapter] = useState<ChapterDto | null>(null);
  const [failed, setFailed] = useState(false);
  const placeholder = useRef<HTMLDivElement | null>(null);
  const loading = useRef(false);

  useEffect(() => {
    setChapter(null);
    setFailed(false);
    loading.current = false;
  }, [entry.n, entry.rev]);

  useEffect(() => {
    if (chapter !== null || failed) return;
    // Observe the placeholder itself, not a 1 px sentinel: a reader who jumps past the
    // top of an unwritten chapter still needs its text when they land inside it.
    const node = placeholder.current;
    if (node === null) return;

    const load = (): void => {
      if (loading.current) return;
      loading.current = true;
      getChapter(entry.n)
        .then((result) => {
          if (result === null) setFailed(true);
          else setChapter(result);
        })
        .catch(() => setFailed(true))
        .finally(() => {
          loading.current = false;
        });
    };

    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: CHAPTER_PREFETCH },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [entry.n, chapter, failed]);

  const retry = (): void => {
    setFailed(false);
  };

  return (
    <article
      className="page ch"
      id={`ch-${entry.n}`}
      data-n={entry.n}
      data-rev={entry.rev}
      aria-label={`глава ${entry.n}`}
    >
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
          {formatChars(entry.chars)} · {formatTime(entry.updatedAt)}
        </span>
      </header>

      {chapter !== null
        ? chapter.blocks.map((block) => (
            <p className="p" key={block.id} data-block-id={block.id}>
              {block.text}
            </p>
          ))
        : null}

      {chapter === null && !failed ? (
        <div
          className="ch-placeholder"
          ref={placeholder}
          style={{ minHeight: estimateChapterHeight(entry.chars, window.innerWidth) }}
          aria-hidden="true"
        />
      ) : null}

      {failed ? (
        <div className="ch-fail">
          <span>глава не загрузилась</span>
          <button type="button" onClick={retry}>
            повторить
          </button>
        </div>
      ) : null}
    </article>
  );
}
