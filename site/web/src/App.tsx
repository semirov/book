import type { CatalogEntry, StateSnapshot } from '@book/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getChapters, getState } from './api.ts';
import { ChapterArticle } from './components/ChapterArticle.tsx';
import { Colophon } from './components/Colophon.tsx';
import { Discussion } from './components/Discussion.tsx';
import { Header } from './components/Header.tsx';
import { Inventory } from './components/Inventory.tsx';
import { Plate } from './components/Plate.tsx';
import { TitleSheet } from './components/TitleSheet.tsx';
import { formatDate } from './lib/format.ts';

type Data = { state: StateSnapshot; catalog: CatalogEntry[] };

/**
 * One page, the book in order (DESIGN §5.2). The order is the book's order: title sheet,
 * the chapters that exist, the опись where the book stops, the backward front, the
 * discussion, the colophon. There is no navigation besides the опись rows.
 */
export function App() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    Promise.all([getState(), getChapters()])
      .then(([state, catalog]) => setData({ state, catalog }))
      .catch(() => setFailed(true));
  }, []);

  useEffect(load, [load]);

  if (failed && data === null) {
    return (
      <main className="page">
        <div className="state-line">
          <span>опись не прочиталась</span>
          <button type="button" onClick={load}>
            повторить
          </button>
        </div>
      </main>
    );
  }

  if (data === null) {
    return (
      <main className="page" aria-busy="true">
        <div className="state-line">
          <span>опись читается</span>
        </div>
      </main>
    );
  }

  const { state, catalog } = data;
  const written = catalog.filter((entry) => entry.written);
  const forwardFront = state.meeting.forwardFront;
  const startedAt =
    written
      .map((entry) => entry.writtenAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
  const startedLabel = startedAt === null ? null : formatDate(startedAt);

  const flow: ReactNode[] = [];
  if (written.length === 0) {
    flow.push(<Plate key="plate" state={state} />);
    flow.push(<Inventory key="inv" catalog={catalog} startedAt={null} />);
  } else if (forwardFront === null) {
    // Only the backward half exists: the опись still stands where the book stops.
    flow.push(<Inventory key="inv" catalog={catalog} startedAt={startedLabel} />);
  }

  for (const entry of written) {
    flow.push(<ChapterArticle key={entry.n} entry={entry} />);
    if (forwardFront !== null && entry.n === forwardFront) {
      flow.push(<Inventory key="inv" catalog={catalog} startedAt={startedLabel} />);
    }
  }

  flow.push(<Discussion key="talks" depth={state.queue.depth} chapterCount={state.chapters.count} />);

  return (
    <>
      <Header state={state} />
      <TitleSheet state={state} />
      <main>{flow}</main>
      <Colophon state={state} />
    </>
  );
}
