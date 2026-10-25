/**
 * The опись is a form, not a table of contents: a run of empty chapters collapses into
 * one summary row — except on day one, when the 67 blank fields *are* the page.
 */

import type { CatalogEntry } from '@book/shared';

export type SlotRow =
  | { kind: 'written'; entry: CatalogEntry }
  | { kind: 'empty'; entry: CatalogEntry }
  | { kind: 'run'; from: number; to: number; count: number };

export type GroupOptions = {
  /** Runs of at least this many empty chapters collapse (DESIGN §7.15 uses 56 → one row). */
  collapseMin?: number;
  /** Keys of runs the reader expanded, `${from}-${to}`. */
  expanded?: ReadonlySet<string>;
};

export function groupSlots(entries: readonly CatalogEntry[], options: GroupOptions = {}): SlotRow[] {
  const collapseMin = options.collapseMin ?? 4;
  const expanded = options.expanded ?? new Set<string>();
  const dayOne = entries.length > 0 && entries.every((entry) => !entry.written);
  const rows: SlotRow[] = [];

  let run: CatalogEntry[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    const from = run[0]?.n ?? 0;
    const to = run[run.length - 1]?.n ?? 0;
    const collapsed = run.length >= collapseMin && !dayOne && !expanded.has(`${from}-${to}`);
    if (collapsed) {
      rows.push({ kind: 'run', from, to, count: run.length });
    } else {
      for (const entry of run) rows.push({ kind: 'empty', entry });
    }
    run = [];
  };

  for (const entry of entries) {
    if (entry.written) {
      flushRun();
      rows.push({ kind: 'written', entry });
      continue;
    }
    run.push(entry);
  }
  flushRun();

  return rows;
}

/** Label of the summary row: `10—65` → `10—65`, dashed with the long dash of the book. */
export function runLabel(from: number, to: number): string {
  return `${String(from).padStart(2, '0')}—${String(to).padStart(2, '0')}`;
}
