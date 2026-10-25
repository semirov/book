import { chapterLabel, type CatalogEntry } from '@book/shared';
import { useState, type ReactNode } from 'react';

import { formatChars, plural } from '../lib/format.ts';
import { groupSlots, runLabel } from '../lib/inventory.ts';

function scrollToChapter(n: number): void {
  const target = document.getElementById(`ch-${n}`);
  if (target === null) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

export type InventoryProps = {
  catalog: readonly CatalogEntry[];
  /** `25.10.2026` — the first sighting of the first chapter, or null on day one. */
  startedAt: string | null;
};

/**
 * Опись (DESIGN §7.15): every slot in order, a dotted leader, a label in the voice of
 * the form. Long runs of empty chapters fold into one summary row; on day one all 67
 * blank fields are shown, because then the form is the page.
 */
export function Inventory({ catalog, startedAt }: InventoryProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = groupSlots(catalog, { expanded });

  const toggle = (key: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const items: ReactNode[] = rows.map((row) => {
    if (row.kind === 'written') {
      return (
        <li className="slot written" key={`w-${row.entry.n}`}>
          <button className="slot-inner" type="button" onClick={() => scrollToChapter(row.entry.n)}>
            <span className="n">{chapterLabel(row.entry.n)}</span>
            <span className="leader" aria-hidden="true" />
            <span className="s">
              {formatChars(row.entry.chars)}
              {row.entry.direction === 'backward' ? ' · ←' : ''}
            </span>
          </button>
        </li>
      );
    }
    if (row.kind === 'empty') {
      return (
        <li className="slot" key={`e-${row.entry.n}`}>
          <span className="slot-inner">
            <span className="n">{chapterLabel(row.entry.n)}</span>
            <span className="leader" aria-hidden="true" />
            <span className="s">пусто</span>
          </span>
        </li>
      );
    }
    const key = `${row.from}-${row.to}`;
    return (
      <li className="slot summary" key={`r-${key}`}>
        <button
          className="slot-inner"
          type="button"
          onClick={() => toggle(key)}
          aria-label={`показать главы ${row.from}—${row.to}`}
        >
          <span className="n">{runLabel(row.from, row.to)}</span>
          <span className="leader" aria-hidden="true" />
          <span className="s">
            {row.count} {plural(row.count, 'глава', 'главы', 'глав')} · пусто
          </span>
        </button>
      </li>
    );
  });

  return (
    <section className="page inv" id="inv">
      <header className="sec-h">
        <span className="lbl">опись</span>
        <span className="sec-meta">главы 01—67</span>
      </header>
      <ul className="slots">{items}</ul>
      <div className="inv-foot">
        <span>подгружается по ходу чтения</span>
        <span>{startedAt ? `начата ${startedAt}` : 'не начата'}</span>
      </div>
    </section>
  );
}
