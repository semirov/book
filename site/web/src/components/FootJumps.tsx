import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { GRIP, initialGrip, nextGrip, type GripEvent, type GripState } from '../lib/grip.ts';

/**
 * BOOK-156 / BOOK-207 — the grip: the page's fixed foot with three jumps
 * (оглавление · обсуждение · след).
 *
 * The band is the column's own paper with one hairline; this component owns only what moves
 * inside it: the row's height (a tap on the paper, or focus), its dwell, the cut on a fling.
 * The clock is pure (`lib/grip.ts`); the geometry and every duration are in
 * `styles/foot-jumps.css`.
 *
 * BOOK-207 deleted the carets door: the third item is a plain anchor to `#след`, so there is
 * no watch, no veil, no cut to the live block and no state table under the word.
 */

export type FootJumpsProps = {
  /** `state.history.live` — no past means no register, so «обсуждение» is absent. */
  live: boolean;
  /** `.capacity-plate` is on the page: the plate owns the bottom and already reserves space. */
  plate: boolean;
};

const now = (): number => Date.now();

function readReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function FootJumps({ live, plate }: FootJumpsProps): ReactElement | null {
  const [grip, setGrip] = useState<GripState>(() => initialGrip());
  const [reduced, setReduced] = useState(readReduced);
  /** Any pointer or keyboard activity inside the nav restarts the dwell. */
  const [activity, setActivity] = useState(0);
  const nav = useRef<HTMLElement | null>(null);

  const feed = useCallback((event: GripEvent): void => {
    setGrip((current) => nextGrip(current, event));
  }, []);

  // The media query is read once at mount and on `change`: `base.css` kills CSS transitions
  // but not a state the module applies, so the module gates itself (#3797 §5).
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    setGrip((current) => (current.reduced === reduced ? current : { ...current, reduced }));
  }, [reduced]);

  // The dwell: 3 200 ms without pointer or keyboard activity inside the nav. A timer is not
  // motion: `prefers-reduced-motion` zeroes the durations, never the dwell (BOOK-156 fix).
  useEffect(() => {
    if (!grip.open) return;
    // The deadline is the effect's own clock plus the dwell: the timer's callback carries it,
    // so the module never has to guess whether the harness fakes `performance.now`.
    const deadline = now() + GRIP.dwellMs;
    const id = window.setTimeout(() => {
      feed({ type: 'timer', atMs: deadline });
    }, GRIP.dwellMs);
    return () => window.clearTimeout(id);
  }, [grip.open, grip.openedAt, reduced, activity, feed]);

  // A deferred entrance (after a fling) lands on the first tick where the momentum is spent.
  // An interval, not one timeout: after a flick the first tick may only show that the quiet
  // window has begun, and the row must not wait for the reader to scroll again (#156 B1).
  useEffect(() => {
    if (!grip.target || grip.open) return;
    const id = window.setInterval(() => feed({ type: 'timer', atMs: now() }), GRIP.holdMs);
    return () => window.clearInterval(id);
  }, [grip.target, grip.open, feed]);

  // One passive listener, one `scrollY` read, a subtraction — no second rAF on the page.
  // A zero-delta sample is fed too: it is how a momentum scroll reports that it has stopped,
  // and the fling gate needs that sample to start its 100 ms of stillness.
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = (): void => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      feed({ type: 'scroll', atMs: now(), dy });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [feed]);

  // A pointerdown outside the grip closes the row and is not swallowed: the tap goes on to
  // the prose, where a tap already means «вмешаться».
  useEffect(() => {
    const onPointerDown = (event: Event): void => {
      const element = nav.current;
      if (element === null) return;
      if (event.target instanceof Node && element.contains(event.target)) return;
      feed({ type: 'outside', atMs: now() });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [feed]);

  if (plate) return null;

  return (
    <nav
      className="foot-jumps"
      aria-label="переходы"
      tabIndex={-1}
      ref={nav}
      data-open={grip.open ? 'true' : 'false'}
      data-cut={grip.motion === 'cut' ? 'true' : 'false'}
      onFocus={(event) => {
        // A keyboard reader who tabs into the nav gets the row at once; a tap on a word is a
        // jump, never an expand.
        if (!(event.target instanceof Element) || !event.target.matches('a.foot-jump')) return;
        feed({ type: 'focus', atMs: now() });
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        feed({ type: 'blur', atMs: now() });
      }}
      onPointerMove={() => setActivity((n) => n + 1)}
      onPointerDown={() => setActivity((n) => n + 1)}
      onKeyDown={() => setActivity((n) => n + 1)}
    >
      <div className="canvas">
        <div className="page foot-jumps-in">
          {/* The expander: behind the words, covering the band and the item's own box. A tap
              on the paper is never a no-op; a tap on a word is a jump. */}
          <button
            className="foot-jumps-open"
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => feed({ type: 'paper', atMs: now() })}
          />
          <a className="foot-jump" href="#toc">
            <span className="foot-jump-word">оглавление</span>
          </a>
          {live ? (
            <a className="foot-jump" href="#discussion">
              <span className="foot-jump-word">обсуждение</span>
            </a>
          ) : null}
          {/* BOOK-207 — the reader's own page, always present: a reader with no filings gets
              the honest zero there, not a missing item here. */}
          <a className="foot-jump" href="#след">
            <span className="foot-jump-word">след</span>
          </a>
        </div>
      </div>
    </nav>
  );
}
