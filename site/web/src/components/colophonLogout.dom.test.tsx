// @vitest-environment jsdom
import { IMPRINT_AUTHOR, IMPRINT_COPYRIGHT, type StateSnapshot } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Colophon } from './Colophon.tsx';
import { LOGOUT_FAILED } from './LogoutRow.tsx';

/**
 * BOOK-115 — leaving, as a real request.
 *
 * The row's copy and the sheet are in `colophon.test.tsx`; this file mounts the footer in
 * jsdom because the behaviour needs a browser's event loop: one POST while in flight, the
 * button locked for the duration, a full reload only after the answer, and a failure that
 * stays on the page instead of navigating. `reload` is injected — jsdom cannot navigate, and a
 * route replacing would not re-read the surfaces the way the reload does.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = {
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0 },
} as unknown as StateSnapshot;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** Let the request's promise and React's update land in one commit. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function mount(viewer: { signedIn: boolean; displayName: string | null }, reload: (url: string) => void): void {
  void act(() => {
    root?.render(
      <Colophon
        state={state}
        imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }}
        viewer={viewer}
        reload={reload}
      />,
    );
  });
}

function button(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>('.logout') ?? null;
}

/** A fetch answer that never resolves until the test says so. */
function deferred(): { resolve: () => void; promise: Promise<Response> } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<Response>((settle) => {
    resolve = () => settle({ ok: true, status: 200 } as Response);
  });
  return { resolve, promise };
}

describe('the logout button (BOOK-115)', () => {
  it('posts once to /auth/logout and reloads into a guest session', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    mount({ signedIn: true, displayName: 'Филипп' }, reload);

    const out = button();
    expect(out?.textContent).toBe('выйти');
    await act(async () => out?.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/auth/logout');
    // §17: a state-changing act is a POST, never a navigation.
    expect(init.method).toBe('POST');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('/');
  });

  it('disables the button while the request is in flight, and posts nothing twice', async () => {
    const wait = deferred();
    const fetchMock = vi.fn(() => wait.promise);
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    mount({ signedIn: true, displayName: 'Филипп' }, reload);

    const out = button();
    await act(async () => out?.click());
    // The request has not answered: the word is still there, the control is not.
    expect(button()?.disabled).toBe(true);
    await act(async () => button()?.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => wait.resolve());
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stays on the page when the POST fails, and offers the attempt again', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, statusText: 'boom', json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    mount({ signedIn: true, displayName: 'Филипп' }, reload);

    await act(async () => button()?.click());
    await flush();

    // No navigation: the reader is still signed in, and the line says so.
    expect(reload).not.toHaveBeenCalled();
    expect(container?.querySelector('.logout-error')?.textContent).toBe(LOGOUT_FAILED);
    expect(LOGOUT_FAILED).toBe('выйти не вышло · попробуйте ещё раз');
    expect(button()?.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A retry is allowed, and the old line goes with the new attempt — not one request later.
    const retry = deferred();
    fetchMock.mockImplementation(async () => retry.promise);
    await act(async () => button()?.click());
    expect(container?.querySelector('.logout-error')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => retry.resolve());
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('posts nothing at all when the reader is signed out', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    mount({ signedIn: false, displayName: null }, reload);

    expect(button()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
