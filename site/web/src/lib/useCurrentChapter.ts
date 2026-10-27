import { useEffect, useState } from 'react';

/**
 * BOOK-90 B — the chapter the reader is in, for the running head.
 *
 * One `IntersectionObserver` over the chapter slots, with a narrow band just under the sticky
 * head: the **first** slot in document order that crosses the band is the chapter being read.
 * The callback fires on band crossings only — never per pixel — and the state is set only when
 * the chapter (or its word) actually changes, so a lazy chapter mounting cannot make the head
 * flicker.
 *
 * The slot list is not captured once: a chapter can be created live (`chapter:created`) or
 * remounted, so a `MutationObserver` re-scans the list, observes the new slots and drops the
 * detached ones. The band starts at the head's own offset token (`--offset-top`), not at a
 * number copied from the sheet.
 *
 * The word is not a second table: it is what the slot itself prints (`chapter-title` for a
 * written chapter, the row's label for an empty one). The head echoes the page.
 */

export type CurrentChapter = {
  n: number;
  /** The chapter's real title, when it has one (the header prefers it). */
  title: string | null;
  /** The slot's own state word: «замысел» for an empty chapter, a filing's word otherwise. */
  word: string | null;
};

/** The head's offset when the token cannot be read (tests, SSR). */
const HEAD_FALLBACK = 64;

function headOffset(): number {
  if (typeof getComputedStyle === 'undefined') return HEAD_FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--offset-top');
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : HEAD_FALLBACK;
}

/** The two words the slot prints, read from the slot itself. */
export function chapterCopyOf(article: Element): { title: string | null; word: string | null } {
  const title = article.querySelector('.ch-title')?.textContent?.trim() ?? '';
  const row = article.querySelector('.premise-label')?.textContent?.trim() ?? '';
  return { title: title.length > 0 ? title : null, word: row.length > 0 ? row : null };
}

export function useCurrentChapter(enabled = true): CurrentChapter | null {
  const [current, setCurrent] = useState<CurrentChapter | null>(null);

  useEffect(() => {
    // Server render, no observer, or the head is off: it names no chapter.
    if (!enabled || typeof document === 'undefined' || typeof IntersectionObserver === 'undefined') {
      setCurrent(null);
      return;
    }

    let articles: HTMLElement[] = [];
    const inBand = new Set<Element>();

    const commit = (): void => {
      const first = articles.find((article) => inBand.has(article));
      const next: CurrentChapter | null =
        first === undefined ? null : { n: Number(first.dataset.n), ...chapterCopyOf(first) };
      // The same chapter (and the same words) is not an update: the head keeps its slot.
      setCurrent((previous) =>
        previous?.n === next?.n && previous?.title === next?.title && previous?.word === next?.word
          ? previous
          : next,
      );
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target);
          else inBand.delete(entry.target);
        }
        commit();
      },
      { rootMargin: `-${headOffset()}px 0px -68% 0px`, threshold: 0 },
    );

    const known = new Set<Element>();
    /** Follow the slot list: observe new articles, unobserve detached ones. */
    const scan = (): void => {
      articles = [...document.querySelectorAll<HTMLElement>('article.ch[data-n]')];
      const live = new Set<Element>(articles);
      for (const element of known) {
        if (live.has(element)) continue;
        known.delete(element);
        inBand.delete(element);
        observer.unobserve(element);
      }
      for (const article of articles) {
        if (known.has(article)) continue;
        known.add(article);
        observer.observe(article);
      }
      commit();
    };

    scan();
    const mutations = new MutationObserver(() => scan());
    mutations.observe(document.body, { childList: true, subtree: true });

    // Unmount / disable: no observation survives, and the head forgets the chapter.
    return () => {
      mutations.disconnect();
      observer.disconnect();
      setCurrent(null);
    };
  }, [enabled]);

  return current;
}
