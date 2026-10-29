// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAPACITY_PLATE, CAPACITY_STATE } from '../lib/capacity.ts';
import { CapacityPlate } from './CapacityPlate.tsx';

/**
 * BOOK-75 — the full hall's plate: a strip, not a page.
 *
 * The surface is extracted from `App` so this is provable without a socket, an analytics
 * banner and the whole catalogue. The plate states one fact and one state line in the book's
 * voice, carries no apology and no promise of progress, and never takes the page away: the
 * prose above it is REST and keeps reading (AC2). It has no button — the socket reconnects by
 * itself (AC3) — so the last two cases guard the markup and the regression that would put the
 * old full-page waiting screen back.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The component's source and `App`'s, as text: the copy and the regression are sheet-level facts. */
const sources = import.meta.glob<string>(['../App.tsx', '../lib/capacity.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const appSource = sources['../App.tsx'] ?? '';
const copySource = sources['../lib/capacity.ts'] ?? '';

/** The words this surface may not print: it is a queue, not a failure or a consolation. */
const BANNED = ['ошибка', 'перегружено', 'попробуйте позже', 'извините', 'пожалуйста'];

let root: Root | null = null;
let container: HTMLDivElement;
/** Any `console.error` during a case is an act warning or a render error; both fail the case. */
let errorCount: () => number = () => 0;
let restoreConsole: () => void = () => undefined;

beforeEach(() => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  errorCount = () => spy.mock.calls.length;
  restoreConsole = () => spy.mockRestore();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  restoreConsole();
});

async function render(active: boolean): Promise<void> {
  await act(async () => {
    root?.render(<CapacityPlate active={active} />);
  });
}

describe('the capacity plate', () => {
  it('prints the exact plate and state lines as one polite status', async () => {
    await render(true);
    const plate = container.querySelector('.capacity-plate');
    expect(plate).not.toBeNull();
    expect(plate?.getAttribute('role')).toBe('status');
    expect(plate?.getAttribute('aria-live')).toBe('polite');
    expect(plate?.getAttribute('data-capacity')).toBe('waiting');
    expect(container.textContent).toContain(
      CAPACITY_PLATE,
    );
    expect(container.textContent).toContain(
      'Чтение идёт. Подключится само, когда освободится место.',
    );
    expect(CAPACITY_PLATE).toBe('Все места заняты. Вы ждёте места: кто-то уйдёт — и вы войдёте.');
    expect(CAPACITY_STATE).toBe('Чтение идёт. Подключится само, когда освободится место.');
    expect(errorCount()).toBe(0);
  });

  it('renders nothing while there is a seat', async () => {
    await render(false);
    expect(container.innerHTML).toBe('');
    expect(errorCount()).toBe(0);
  });

  it('never says "error", "overloaded", "try later" or an apology', async () => {
    await render(true);
    const markup = container.innerHTML.toLowerCase();
    for (const word of BANNED) {
      expect(markup).not.toContain(word);
      expect(copySource.toLowerCase()).not.toContain(word);
    }
    // A guard against an empty glob: the copy module is really the one under test.
    expect(copySource).toContain('CAPACITY_PLATE');
    expect(errorCount()).toBe(0);
  });

  it('does not replace the page: the prose stays beside the plate', async () => {
    await act(async () => {
      root?.render(
        <>
          <p>абзац книги</p>
          <CapacityPlate active />
        </>,
      );
    });
    expect(container.querySelector('p')?.textContent).toBe('абзац книги');
    expect(container.querySelector('.capacity-plate')).not.toBeNull();
    expect(errorCount()).toBe(0);
  });

  it('leaves no full-page waiting screen in App — a strip beside the prose only', () => {
    expect(appSource).toContain('<CapacityPlate');
    expect(appSource).not.toContain('className="page waiting"');
    expect(appSource).not.toContain('waiting-copy');
    expect(appSource).not.toContain('waiting-retry');
    expect(appSource).not.toContain("if (connection === 'capacity')");
  });
});
