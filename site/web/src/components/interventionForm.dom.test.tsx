// @vitest-environment jsdom
import type { CatalogEntry } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { emptyDraft } from '../lib/draft.ts';
import { InterventionForm } from './InterventionForm.tsx';

/**
 * BOOK-64 — the form a signed-in reader meets: no widget, no iframe, no token, and a submit
 * that goes out on identity alone. The server test proves the 201; this proves the page does
 * not wait for a challenge the deployment no longer runs.
 */

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderForm(body: string): ReturnType<typeof emptyDraft> {
  const draft = { ...emptyDraft({ chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Её освещал ровный свет.', baseRev: 4 }), body };
  act(() => {
    root.render(
      <InterventionForm
        entry={ENTRY}
        draft={draft}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Аня' }}
        onChange={() => undefined}
        onPosted={() => undefined}
      />,
    );
  });
  return draft;
}

describe('the intervention form without a challenge (BOOK-64)', () => {
  it('renders no captcha block, no iframe and no provider word', () => {
    renderForm('свет не от лампы');
    expect(container.querySelector('.seam-captcha')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.innerHTML).not.toMatch(/проверка/iu);
    expect(container.innerHTML).not.toMatch(/turnstile|hcaptcha|cloudflare/iu);
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('submits when the reader is signed in and the text is valid, with no token in the body', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          comment: { id: 'cmt_1' },
          remaining: { perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 1, editsResetAt: null },
          queue: { depth: 0 },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const posted = vi.fn();
    const draft = { ...emptyDraft({ chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Её освещал ровный свет.', baseRev: 4 }), body: 'свет не от лампы' };
    act(() => {
      root.render(
        <InterventionForm
          entry={ENTRY}
          draft={draft}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: true, displayName: 'Аня' }}
          onChange={() => undefined}
          onPosted={posted}
        />,
      );
    });

    const button = container.querySelector('button.seam-submit') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ chapter: 8, body: 'свет не от лампы', blockId: 'ch08#aa11bb22' });
    expect(body).not.toHaveProperty('captchaToken');
    expect(posted).toHaveBeenCalledWith('cmt_1');
  });
});
