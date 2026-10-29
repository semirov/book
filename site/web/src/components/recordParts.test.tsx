// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RECORD_CUT, rowWindow, type RowWindow } from '../lib/recState.ts';
import { RowsList } from './RecordParts.tsx';

/**
 * BOOK-128 #3900 §1 / BOOK-199 m3 — the fold's count is a fact about the list it drew, and a
 * count is never a dead end.
 *
 * The line used to print a literal `6` beside the real total, so the one number the reader can
 * check said the same thing whatever was above it; it then printed `показаны N из M` with no
 * control, so on a seven-row list row 7 was unreachable. The line now reads the window's own
 * length and carries the door that reveals exactly the rows it counts; a window with nothing
 * left prints `свернуть` alone, with no count.
 */

const noop = (): void => undefined;

type Row = { id: string; facts: string; specimen: string };

function rowsOf(total: number): Row[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `row-${String(index)}`,
    facts: `факт ${String(index)}`,
    specimen: `строка ${String(index)}`,
  }));
}

function windowOf(total: number, lifted: boolean): RowWindow<Row> {
  return rowWindow(rowsOf(total), lifted);
}

function list(rows: RowWindow<Row>, total: number, lifted: boolean): string {
  return renderToStaticMarkup(
    <RowsList rows={rows} lifted={lifted} onLift={noop} onFold={noop} total={total} />,
  );
}

let root: Root | null = null;
let container: HTMLDivElement;

/** The list with its own two-step state, mounted the way the record mounts it. */
function Door({ total }: { total: number }) {
  const [lifted, setLifted] = useState(false);
  return (
    <RowsList
      rows={rowWindow(rowsOf(total), lifted)}
      lifted={lifted}
      total={total}
      onLift={() => setLifted(true)}
      onFold={() => setLifted(false)}
    />
  );
}

async function mount(total: number): Promise<void> {
  await act(async () => {
    root?.render(<Door total={total} />);
  });
}

function drawn(): number {
  return container.querySelectorAll('.rec-row').length;
}

function door(): HTMLButtonElement | null {
  // The door lives in the count's line (`ещё N →`), or is the fold line itself (`свернуть`).
  return container.querySelector<HTMLButtonElement>('.rec-fold button, button.rec-fold');
}

async function press(control: HTMLButtonElement | null): Promise<void> {
  await act(async () => control?.click());
}

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('the fold’s count', () => {
  it('prints the rows it drew and the real total, beside the door', () => {
    const html = list(windowOf(8, false), 8, false);
    expect(html).toContain(`показаны ${String(RECORD_CUT)} из 8`);
    // The door names exactly the rows the count leaves out, and it is in the same line.
    expect(html).toContain(`ещё 5 →`);
    expect(html).toContain('class="rec-fold rec-fold-end"');
  });

  it('never prints a count without a control — every length, both steps', () => {
    for (let total = 1; total <= 12; total += 1) {
      for (const lifted of [false, true]) {
        const html = list(windowOf(total, lifted), total, lifted);
        const counted = html.includes('показаны');
        if (counted) {
          // A count is a promise: the way to see the rest stands in the same line.
          expect(html, `${String(total)}/${String(lifted)}`).toContain(`ещё ${String(total - RECORD_CUT)} →`);
          expect(html).toContain('<button');
        }
        // Folded with something left: the count is printed, because the cut cut something.
        expect(counted).toBe(!lifted && total > RECORD_CUT);
      }
    }
  });

  it('prints no fold line while nothing is over the cut', () => {
    const html = list(windowOf(3, false), 3, false);
    expect(html).not.toContain('показаны');
    expect(html).not.toContain('ещё');
    expect(html).not.toContain('свернуть');
  });

  it('when nothing remains, `свернуть` only — no count, no second door', () => {
    const html = list(windowOf(9, true), 9, true);
    expect(html).not.toContain('показаны');
    expect(html).not.toContain('ещё');
    expect(html).toContain('свернуть');
  });
});

describe('the door', () => {
  it('reveals every row that was hidden, at every count 1..12, and folds back', async () => {
    for (let total = 1; total <= 12; total += 1) {
      await mount(total);
      expect(drawn(), `drawn ${String(total)}`).toBe(Math.min(RECORD_CUT, total));
      if (total <= RECORD_CUT) {
        expect(door(), `door ${String(total)}`).toBeNull();
        continue;
      }
      const open = door();
      expect(open, `door ${String(total)}`).not.toBeNull();
      await press(open);
      // Pressing the count's control reveals exactly the remaining rows — all of them.
      expect(drawn(), `opened ${String(total)}`).toBe(total);
      expect(container.textContent ?? '').not.toContain('показаны');
      expect(container.textContent ?? '').toContain('свернуть');
      await press(door());
      expect(drawn(), `folded ${String(total)}`).toBe(RECORD_CUT);
      expect(container.textContent ?? '').toContain(`показаны ${String(RECORD_CUT)} из ${String(total)}`);
    }
  });
});
