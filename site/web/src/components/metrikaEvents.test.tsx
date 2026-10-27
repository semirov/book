// @vitest-environment jsdom
import type { CatalogEntry, ChangeDto, FrontDto } from '@book/shared';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { seamDrafts } from '../lib/draft.ts';
import { anchorFor } from '../lib/seam.ts';
import { closeSeam } from '../lib/useSeam.ts';

/**
 * BOOK-63 — each event fires at the product's act, once, with its fixed shape.
 *
 * `track` is spied here (its own gate and payload cleaning are tested in
 * `lib/analytics.test.ts`); this file proves the acts are wired: the cover rendered, a seam
 * opened from a sentence or an empty chapter, a form opened, a kind picked, a note or an
 * intervention sent, a refusal, the receipt, a document opened. No event is handed any
 * reader text — the call sites pass names, enums, numbers and codes only.
 */

vi.mock('../lib/analytics.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/analytics.ts')>();
  return { ...actual, track: vi.fn(), trackOnce: vi.fn() };
});

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, postAnchoredComment: vi.fn() };
});

import { ApiError, postAnchoredComment } from '../api.ts';
import { track, trackOnce } from '../lib/analytics.ts';
import { ChangeCard } from './ChangeCard.tsx';
import { LegalPage } from './LegalPage.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';
import { Seam } from './Seam.tsx';
import { TitleSheet } from './TitleSheet.tsx';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 8,
  part: 1,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 1,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const BLOCK_ID = 'ch08#aa11bb22';

const FRONT: FrontDto = {
  title: 'Бланк',
  about: 'о книге',
  rev: 2,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 0, measuredAt: '2026-10-25T09:20:00Z' },
};

const CHANGE: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: null,
  cascade: null,
  modes: [],
  steps: [],
  appliedRevs: [],
  cost: null,
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T11:00:00Z',
  startedAt: null,
  decidedAt: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return [];
      }
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  closeSeam();
  seamDrafts.drop('ch8:metrika');
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

function lastCall(name: string): unknown[] | undefined {
  const calls = vi.mocked(track).mock.calls.filter(([called]) => called === name);
  return calls.at(-1);
}

function click(selector: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  act(() => element.click());
}

/** A controlled textarea needs the native setter, or React never sees the change. */
function type(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

function seam(): ReactNode {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
  return (
    <Seam
      entry={ENTRY}
      draftKey="ch8:metrika"
      anchor={anchor}
      frozen={false}
      filings={null}
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: true, displayName: 'Филипп' }}
      onPosted={() => undefined}
      onClose={() => undefined}
      onProvenance={() => undefined}
      onOpenFiling={() => undefined}
    />
  );
}

describe('the cover and the records', () => {
  it('fires cover_seen once for the rendered cover', async () => {
    await render(<TitleSheet front={FRONT} />);
    expect(lastCall('cover_seen')).toEqual(['cover_seen', {}]);
    await render(<TitleSheet front={{ ...FRONT, rev: 3 }} />);
    expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'cover_seen')).toHaveLength(1);
  });

  it('fires record_open once per change, not once per render', async () => {
    await render(<ChangeCard change={CHANGE} onClose={() => undefined} />);
    expect(lastCall('record_open')).toEqual(['record_open', {}]);
    await render(<ChangeCard change={CHANGE} onClose={() => undefined} />);
    expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'record_open')).toHaveLength(1);
    await render(<ChangeCard change={{ ...CHANGE, id: 'chg_2', seq: 15 }} onClose={() => undefined} />);
    expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'record_open')).toHaveLength(2);
  });

  it('reports the two static documents by their own names', async () => {
    await render(<LegalPage page="privacy" />);
    expect(vi.mocked(track)).toHaveBeenCalledWith('privacy_open', {});
    await render(<LegalPage page="rules" />);
    expect(vi.mocked(track)).toHaveBeenCalledWith('rules_open', {});
  });
});

describe('opening a seam', () => {
  it('names the text surface when a sentence is opened', async () => {
    await render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        frozen={false}
        comments={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        history
        onPosted={() => undefined}
      />,
    );
    const sentence = document.querySelector('[data-s]');
    expect(sentence).not.toBeNull();
    act(() => {
      (sentence as HTMLElement).click();
    });
    await act(async () => undefined);
    expect(lastCall('seam_open')).toEqual(['seam_open', { surface: 'text' }]);
  });

  it('marks the first desktop hover as tooltip_seen and leaves touch alone', async () => {
    await render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        frozen={false}
        comments={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        history
        onPosted={() => undefined}
      />,
    );
    const paragraph = document.querySelector('p.p');
    await act(async () => {
      paragraph?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));
    });
    expect(vi.mocked(trackOnce)).not.toHaveBeenCalled();
    await act(async () => {
      paragraph?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    expect(vi.mocked(trackOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trackOnce)).toHaveBeenCalledWith('tooltip_seen', 'tooltip_seen', {});
  });
});

describe('the form and its outcomes', () => {
  it('fires form_open, kind_pick, submit_note and receipt_seen on a note', async () => {
    vi.mocked(postAnchoredComment).mockResolvedValue({
      comment: { id: 'cmt_01J9Z8K4Q7' },
      remaining: { remaining: 9, perHour: 10, editsRemaining: 1, editsPerDay: 1 },
    } as never);

    await render(seam());
    click('.seam-cta');
    expect(lastCall('form_open')).toEqual(['form_open', {}]);

    click('.note-action');
    expect(lastCall('kind_pick')).toEqual(['kind_pick', { kind: 'note' }]);

    type('.seam-text', 'в этом абзаце повтор, это замечание без типа');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.seam-submit')?.click();
    });

    expect(lastCall('submit_note')).toEqual(['submit_note', {}]);
    expect(lastCall('receipt_seen')).toEqual(['receipt_seen', {}]);
    expect(document.querySelector('.seam-receipt')?.textContent).toContain('зарегистрировано');
  });

  it('counts the note once per open, and closing it is not an act', async () => {
    await render(seam());
    click('.seam-cta');

    click('.note-action');
    expect(lastCall('kind_pick')).toEqual(['kind_pick', { kind: 'note' }]);
    expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'kind_pick')).toHaveLength(1);

    // The same action is the way back: closing the note is not a kind pick.
    click('.note-action');
    expect(vi.mocked(track).mock.calls.filter(([name]) => name === 'kind_pick')).toHaveLength(1);
    expect(document.querySelector('.note-action')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('fires submit_intervention when a kind was picked', async () => {
    vi.mocked(postAnchoredComment).mockResolvedValue({
      comment: { id: 'cmt_01J9Z8K4Q8' },
      remaining: { remaining: 8, perHour: 10, editsRemaining: 0, editsPerDay: 1 },
    } as never);

    await render(seam());
    click('.seam-cta');
    click('input[value="testimony"]');
    expect(lastCall('kind_pick')).toEqual(['kind_pick', { kind: 'testimony' }]);

    type('.seam-text', 'свидетель видел, как свет включили до него');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.seam-submit')?.click();
    });
    expect(lastCall('submit_intervention')).toEqual(['submit_intervention', {}]);
  });

  it('keeps a refusal to its code', async () => {
    vi.mocked(postAnchoredComment).mockRejectedValue(new ApiError(403, 'BLOCKED', 'замечания от этого автора не принимаются'));

    await render(seam());
    click('.seam-cta');
    click('.note-action');
    type('.seam-text', 'замечание, которое сервер отклонит по коду');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.seam-submit')?.click();
    });

    expect(lastCall('submit_refused')).toEqual(['submit_refused', { code: 'BLOCKED' }]);
  });

  it('reports a client-side refusal as error_shown, not as a server refusal', async () => {
    await render(seam());
    click('.seam-cta');
    const form = document.querySelector<HTMLFormElement>('form.seam-form');
    expect(form).not.toBeNull();
    await act(async () => {
      form?.requestSubmit();
    });
    expect(lastCall('error_shown')).toEqual(['error_shown', { code: 'INVALID' }]);
    expect(vi.mocked(track)).not.toHaveBeenCalledWith('submit_refused', expect.anything());
  });
});
