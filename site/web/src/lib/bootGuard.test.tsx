// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import shell from '../../index.html?raw';
import { disarmAfterMount } from './bootSignal.ts';
import { stampBuildTokens } from './buildTokens.ts';

/**
 * BOOK-119 — the inline boot guard.
 *
 * The defect it answers: after a deploy a browser held the previous `index.html`, asked for an
 * `assets/index-OLD.js` that the in-place build had deleted, the module never ran, and the page
 * was blank with no word on it. So the shell carries a guard that needs nothing but itself, and
 * this file pins the contract the server's CSP hashes and part B's release layout relies on:
 * one inline script, ≤1024 UTF-8 bytes, silent once the app boots, and a sentence a reader can
 * act on when it does not.
 *
 * jsdom parses the shell but never executes a `type="module"` script — which is exactly the
 * broken-bundle state, not a mock of it. The guard's own source is run by hand, in the page's
 * global (the jsdom window under this environment), because jsdom does not run inline scripts.
 */

/** A build identity the test can look for in the painted copy. */
const IDENTITY = { commit: 'abc1234', stamp: '01.02 03:04' };

/** `web/index.html` with the tokens filled exactly as `vite build` and `vite dev` fill them. */
const SHELL = stampBuildTokens(shell, IDENTITY);

const SENTENCE = 'страница не собралась';

/** The shell as a browser parses it — parsed, so none of its scripts run. */
function parsed(): Document {
  return new DOMParser().parseFromString(SHELL, 'text/html');
}

/** The guard's source as it is served, with the build tokens already replaced. */
function guardSource(): string {
  const guard = parsed().getElementById('boot-guard');
  if (guard === null) throw new Error('the shell has no #boot-guard');
  return guard.textContent ?? '';
}

/**
 * A page in the state the guard is written for: a theme, an empty `#root`, nothing rendered.
 * Then the guard runs — the same bytes the browser gets, in the same global.
 */
function boot(theme: 'day' | 'night' = 'day'): void {
  document.documentElement.dataset.theme = theme;
  document.body.innerHTML = '<div id="root"></div>';
  new Function(guardSource())();
}

/** Did the guard paint the register? */
function painted(): boolean {
  return (document.body.textContent ?? '').includes(SENTENCE);
}

afterEach(() => {
  // The guard holds the window; leave none of it listening into the next test.
  window.__bootGuard?.ok();
  delete window.__bootGuard;
  document.body.innerHTML = '';
});

describe('the shell’s boot guard is one small script, first', () => {
  it('is the shell’s only inline script, and it stands before /theme.js', () => {
    const doc = parsed();
    const guard = doc.getElementById('boot-guard');
    expect(guard, 'the guard has its id').not.toBeNull();
    expect(doc.querySelectorAll('script:not([src])'), 'exactly one inline script in the shell').toHaveLength(1);
    const scripts = [...doc.head.querySelectorAll('script')];
    expect(scripts[0], 'the guard is the first script in <head>').toBe(guard);
    const theme = scripts.findIndex((script) => script.getAttribute('src') === '/theme.js');
    expect(theme, '/theme.js is still there').toBeGreaterThan(0);
  });

  it('carries no build token once stamped: a dev page shows a value, never `%BUILD_…%`', () => {
    expect(SHELL).not.toContain('%BUILD_');
  });

  it('spends at most 1024 UTF-8 bytes — the CSP hash is computed from these exact bytes', () => {
    // `Buffer` is not the SPA's to use (the arch gate forbids `node:` imports under web/src);
    // TextEncoder counts the same UTF-8 bytes the server hashes. The shape is the one
    // `scripts/build-info.mjs` writes: a 7-character sha and a `dd.mm hh:mm` stamp.
    const bytes = new TextEncoder().encode(guardSource()).byteLength;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(1024);
  });

  it('holds the same budget with a full 40-character sha in the manifest', () => {
    // The budget only ever held for a 7-character sha: `BOOK_BUILD_COMMIT` (a Docker `ARG`, a
    // compose override) is explicit and may be full length, and the 33 extra bytes are 1047 —
    // over. The rendered guard is the bytes the server hashes and serves, so the cut is there.
    const full = '0123456789abcdef0123456789abcdef01234567';
    const doc = new DOMParser().parseFromString(stampBuildTokens(shell, { commit: full, stamp: IDENTITY.stamp }), 'text/html');
    const guard = doc.getElementById('boot-guard')?.textContent ?? '';
    expect(guard).toContain(`сборка ${full.slice(0, 7)}`);
    expect(guard, 'the full sha is not in the guard').not.toContain(full);
    expect(new TextEncoder().encode(guard).byteLength).toBeLessThanOrEqual(1024);
  });
});

describe('stampBuildTokens', () => {
  it('fills both shell tokens with the build identity', () => {
    expect(stampBuildTokens('<b>%BUILD_COMMIT% %BUILD_STAMP%</b>', IDENTITY)).toBe('<b>abc1234 01.02 03:04</b>');
  });

  it('refuses a value that would end the guard’s string literal', () => {
    // The tokens land inside a script; a quote there would break the shell, not just the stamp.
    expect(stampBuildTokens('%BUILD_COMMIT%|%BUILD_STAMP%', { commit: "a'b", stamp: '1"' })).toBe(
      'dev|00.00 00:00',
    );
  });

  it('renders the commit in seven characters, whatever the manifest carries', () => {
    const full = '0123456789abcdef0123456789abcdef01234567';
    expect(stampBuildTokens('%BUILD_COMMIT%', { commit: full, stamp: 'x' })).toBe(full.slice(0, 7));
  });
});

describe('the guard speaks when nothing can boot', () => {
  it('paints the register on a window error, with the build and a cache-busting reload', () => {
    boot();
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
    expect(document.body.textContent).toBe(
      `страница не собралась · сборка ${IDENTITY.commit} · ${IDENTITY.stamp} · перезагрузить`,
    );
    const link = document.body.querySelector('a');
    expect(link, 'the last word is a real link').not.toBeNull();
    expect(link?.getAttribute('href')).toMatch(/^\/\?r=\d+$/u);
  });

  it('paints on an unhandled rejection before boot', () => {
    boot();
    window.dispatchEvent(new Event('unhandledrejection'));
    expect(painted()).toBe(true);
  });

  it('dresses the register in the shell’s own inks, with no stylesheet behind it', () => {
    // CSSOM only: `style-src 'self'` drops a literal `style="…"` attribute, so the guard
    // writes through `element.style` — the same two answers `theme.js` put on <html>.
    const cases = [
      ['day', 'rgb(20, 23, 26)', 'rgb(207, 211, 210)'],
      ['night', 'rgb(232, 230, 225)', 'rgb(11, 12, 13)'],
    ] as const;
    for (const [theme, ink, paper] of cases) {
      boot(theme);
      window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
      expect(document.body.style.color, theme).toBe(ink);
      expect(document.body.style.background, theme).toBe(paper);
      expect(document.body.style.fontFamily, theme).toContain('PT Serif');
    }
  });

  it('paints when the critical entry script fails to load', () => {
    boot();
    const entry = document.createElement('script');
    entry.type = 'module';
    entry.setAttribute('data-critical', '');
    document.body.appendChild(entry);
    entry.dispatchEvent(new Event('error'));
    expect(painted()).toBe(true);
  });

  it('paints five seconds after load while #root is still empty', () => {
    vi.useFakeTimers();
    try {
      boot();
      window.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(4999);
      expect(painted(), 'not before the five seconds are up').toBe(false);
      vi.advanceTimersByTime(1);
      expect(painted()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the guard stays quiet once the page is alive', () => {
  it('is silent after the app calls ok(), even when an error follows', () => {
    boot();
    window.__bootGuard?.ok();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after boot' }));
    window.dispatchEvent(new Event('unhandledrejection'));
    expect(painted()).toBe(false);
  });

  it('steps aside when #root already has a child: the app is alive, nothing to cover', () => {
    boot();
    document.getElementById('root')?.appendChild(document.createElement('b'));
    window.dispatchEvent(new ErrorEvent('error', { message: 'late' }));
    expect(painted()).toBe(false);
  });

  it('looks for #root at trigger time, not at parse time — it runs in <head>', () => {
    // The shell's own order: the guard executes while <head> is parsing, so `#root` does not
    // exist yet. A lookup taken at parse time would be `null` and the guard would never paint.
    document.body.innerHTML = '';
    new Function(guardSource())();
    document.body.innerHTML = '<div id="root"></div>';
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
    expect(painted()).toBe(true);
  });

  it('ignores a resource error that is not the entry script — a theme file, a font, an image', () => {
    boot();
    const theme = document.createElement('script');
    theme.setAttribute('src', '/theme.js');
    const icon = document.createElement('img');
    icon.setAttribute('src', '/favicon.svg');
    for (const element of [theme, icon]) {
      document.head.appendChild(element);
      element.dispatchEvent(new Event('error'));
    }
    expect(painted(), 'theme.js, fonts and images are not the entry').toBe(false);
  });
});

/**
 * The review's finding: `window.__bootGuard.ok()` ran in the same tick as `createRoot().render()`,
 * which only schedules work — so the guard's listeners and its five-second timer were gone while
 * `#root` was still empty, and "loaded but failed to render" was a blank page. The signal now
 * waits for a fact: `lib/bootSignal.ts`.
 */
describe('the boot signal waits for a fact, not for the render call', () => {
  /** Frames driven by hand: one call is one animation frame in a browser. */
  function manualFrames(): { queue: Array<() => void>; schedule: (callback: () => void) => number } {
    const queue: Array<() => void> = [];
    return {
      queue,
      schedule: (callback) => {
        queue.push(callback);
        return queue.length;
      },
    };
  }

  it('does not disarm on the render tick: a render that never commits still prints the sentence', () => {
    vi.useFakeTimers();
    try {
      boot();
      const container = document.getElementById('root');
      expect(container, 'the shell has #root').not.toBeNull();
      const guard = vi.fn(() => window.__bootGuard?.ok());
      const frames = manualFrames();
      disarmAfterMount({ container: container!, guard, frames: frames.schedule });

      // `render` only schedules: ten frames pass with no child, so the guard is still armed.
      for (let frame = 0; frame < 10; frame += 1) frames.queue.shift()?.();
      expect(guard, 'nothing disarms before the container has a child').not.toHaveBeenCalled();
      expect(frames.queue, 'it keeps asking, one frame at a time').toHaveLength(1);

      window.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(5000);
      expect(painted(), 'the sentence prints even though the bundle itself ran').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms exactly once on the first frame that has a child, and stops asking', () => {
    boot();
    const container = document.getElementById('root');
    const guard = vi.fn(() => window.__bootGuard?.ok());
    const frames = manualFrames();
    disarmAfterMount({ container: container!, guard, frames: frames.schedule });

    container?.appendChild(document.createElement('b'));
    frames.queue.shift()?.();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(frames.queue).toHaveLength(0);
    window.dispatchEvent(new ErrorEvent('error', { message: 'after boot' }));
    expect(painted()).toBe(false);
  });

  it('stops asking once the guard has painted: the container left the document', () => {
    vi.useFakeTimers();
    try {
      boot();
      const container = document.getElementById('root');
      const guard = vi.fn(() => window.__bootGuard?.ok());
      const frames = manualFrames();
      disarmAfterMount({ container: container!, guard, frames: frames.schedule });

      window.dispatchEvent(new Event('load'));
      vi.advanceTimersByTime(5000);
      expect(painted()).toBe(true);
      expect(container?.isConnected, 'the guard emptied the body').toBe(false);

      frames.queue.shift()?.();
      expect(frames.queue, 'no endless poll after the guard has spoken').toHaveLength(0);
      expect(guard, 'a painted guard is not disarmed by the SPA').not.toHaveBeenCalled();
      expect(painted(), 'the sentence stays').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not disarm into a container the guard already detached', () => {
    // The order of the two facts matters: a late commit lands in the detached `#root`, and
    // disarming then would remove the sentence and leave the page empty for real.
    boot();
    const container = document.getElementById('root');
    document.body.textContent = ''; // what the guard's paint does
    container?.appendChild(document.createElement('b')); // a render that committed too late
    const guard = vi.fn(() => window.__bootGuard?.ok());
    const frames = manualFrames();
    disarmAfterMount({ container: container!, guard, frames: frames.schedule });
    expect(guard).not.toHaveBeenCalled();
    expect(frames.queue).toHaveLength(0);
  });
});
