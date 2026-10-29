// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TRAIL_HASH, isTrailHash, useTrail } from './useTrail.ts';

/** BOOK-207 — `#след` is a hash mode of the same page: decoded, exact, no other hash. */
function Mode(): React.ReactElement {
  const open = useTrail();
  return <span data-open={open ? 'true' : 'false'} />;
}

let root: Root | null = null;
let container: HTMLDivElement;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.location.hash = '';
});

describe('the trail’s hash mode', () => {
  it('matches the decoded fragment exactly', () => {
    expect(TRAIL_HASH).toBe('#след');
    expect(isTrailHash('#след')).toBe(true);
    expect(isTrailHash(`#${encodeURIComponent('след')}`)).toBe(true);
    expect(isTrailHash('#след-2')).toBe(false);
    expect(isTrailHash('#ch-12')).toBe(false);
    expect(isTrailHash('')).toBe(false);
    expect(isTrailHash('#%E0%A4%A')).toBe(false);
  });

  it('follows the address bar while the page stays mounted', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.location.hash = '';
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    await act(async () => root?.render(<Mode />));
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');
    await act(async () => {
      window.location.hash = 'след';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('true');
    await act(async () => {
      window.location.hash = 'toc';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.firstElementChild?.getAttribute('data-open')).toBe('false');
  });
});
