import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react';

import {
  GRIP,
  initialGrip,
  nextGrip,
  passDoor,
  type GripEvent,
  type GripState,
  type PassFacts,
} from '../lib/grip.ts';
import { plainChangeClick } from '../lib/changeDoor.ts';
import { openPassStrip } from '../lib/usePassStrip.ts';

/**
 * The door's chapter is resolved by the grip's pure module (`liveChapter`); it is re-exported
 * here so `App` resolves it in the same single mount expression — `App.tsx` is at 483 of the
 * 500-line limit (BOOK-DOC-49 §7), and a second import line would cross it.
 */
export { liveChapter } from '../lib/grip.ts';

/**
 * BOOK-156 — the grip: the page's fixed foot with three jumps (оглавление · обсуждение ·
 * каретки), and the door to the carets.
 *
 * The band is the column's own paper with one hairline; this component owns only what moves
 * inside it: the row's height (a tap on the paper, or focus), its dwell, the cut on a fling,
 * and the door's veil. The clock and the three states of the third item are pure
 * (`lib/grip.ts`); the geometry and every duration are in `styles/foot-jumps.css`.
 *
 * The door is a **cut under a veil, never a scroll** (#3797 §3): any programmatic scroll
 * across a chapter drags the eye through text the reader did not ask for, and it fires the
 * grip's own 48 px rule mid-transition. `scrollToChapter` is never called here.
 */

export type FootJumpsChange = { id: string; decidedAt: string | null; enqueuedAt: string };

export type FootJumpsProps = {
  /** `state.history.live` — no past means no register and no pass, so both items are absent. */
  live: boolean;
  /** `state.queue.processing !== null` — the engine is inside a change now. */
  processing: boolean;
  /** Any `revising[n].active` — a block carries the ochre rule now. */
  revising: boolean;
  /** The live pass's chapter, for the door's one fallback (`#ch-<n>`, or a single load). */
  chapter: number | null;
  /** `changes[0]`, the row the register prints first; `null` when the page holds none. */
  change: FootJumpsChange | null;
  /** `.capacity-plate` is on the page: the plate owns the bottom and already reserves 112 px. */
  plate: boolean;
  /** The existing chapter loader — the door calls it at most once. */
  onLoad?: (n: number) => void;
};

type Watch = 'off' | 'entering' | 'on';
type Veil = null | 'zero' | 'in' | 'out';
type Place = { y: number; blockId: string; dy: number };

const now = (): number => Date.now();

/** The head's offset, from the sheet's own token (the fallback is a test or an SSR page). */
function headOffset(): number {
  if (typeof getComputedStyle !== 'function') return 64;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--offset-top'));
  return Number.isFinite(value) && value > 0 ? value : 64;
}

function topOf(element: Element): number {
  return element.getBoundingClientRect().top + window.scrollY;
}

function maxScroll(): number {
  const root = document.documentElement;
  return Math.max(0, root.scrollHeight - window.innerHeight);
}

/** `behavior: 'auto'` in both directions: never smooth, never a scroll nobody asked for. */
function scrollToY(top: number): void {
  window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
}

function readReduced(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function FootJumps({
  live,
  processing,
  revising,
  chapter,
  change,
  plate,
  onLoad,
}: FootJumpsProps): ReactElement | null {
  const facts: PassFacts = { processing, revising, historyLive: live, change };
  const [grip, setGrip] = useState<GripState>(() => initialGrip());
  const [reduced, setReduced] = useState(readReduced);
  const [watch, setWatch] = useState<Watch>('off');
  const [veil, setVeil] = useState<Veil>(null);
  /** Any pointer or keyboard activity inside the nav restarts the dwell. */
  const [activity, setActivity] = useState(0);
  /** The last pointerdown: a pointer focuses too, and that focus is not a keyboard arriving. */
  const pointerAt = useRef(Number.NEGATIVE_INFINITY);

  const nav = useRef<HTMLElement | null>(null);
  const doorRef = useRef<HTMLAnchorElement | null>(null);
  const veilRef = useRef<HTMLDivElement | null>(null);
  const saved = useRef<Place | null>(null);
  /** The live pass the watch is inside: a different pass is a different entrance (#156 M2). */
  const watchKey = useRef<string | null>(null);
  const doorTimers = useRef<number[]>([]);
  const locked = useRef(false);
  /** The chapter loader is called once per mount, not once per tap (§4). */
  const loaded = useRef(false);

  const feed = useCallback((event: GripEvent): void => {
    setGrip((current) => nextGrip(current, event));
  }, []);

  /**
   * The live pass's identity: the change the queue points at and the chapter it moves. The
   * watch belongs to one pass, so this is what tells a new entrance from the same one.
   */
  const liveKey = live && (processing || revising) ? `${change?.id ?? ''}·${chapter ?? ''}` : null;

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

  // A cut is one commit with no envelope. Clear the flag after it is painted, or the next
  // transition would silently inherit the cut.
  useEffect(() => {
    if (grip.motion !== 'cut') return;
    const id = window.setTimeout(() => {
      setGrip((current) => (current.motion === 'cut' ? { ...current, motion: 'none' } : current));
    }, 0);
    return () => window.clearTimeout(id);
  }, [grip.motion, grip.committedAt]);

  // The veil starts at opacity 0 and is flipped after one layout read, so the fade has a
  // start value; without it the browser paints 0.26 and the veil pops.
  useLayoutEffect(() => {
    if (veil !== 'zero') return;
    const element = veilRef.current;
    if (element === null) return;
    void element.offsetHeight;
    setVeil('in');
  }, [veil]);

  const clearDoor = useCallback((): void => {
    for (const id of doorTimers.current) window.clearTimeout(id);
    doorTimers.current = [];
  }, []);

  useEffect(() => clearDoor, [clearDoor]);

  // The third item's state is the page's, not the row's: a pass that starts or settles while
  // the grip is on screen changes one word's meta, never the row. The watch, though, belongs
  // to one pass: a *different* pass beginning is a new entrance, and the saved place is that
  // of the pass which ended — never this one's (#156 M2). A pass that merely settles keeps
  // the watch, because the return is still the item's job even when the state table has
  // already turned it into the record's link.
  useEffect(() => {
    if (watch === 'off') {
      watchKey.current = liveKey;
      return;
    }
    if (liveKey === null || watchKey.current === liveKey) return;
    watchKey.current = liveKey;
    // An entrance still in flight belongs to the pass that ended: it is cancelled, not
    // allowed to land `watch: 'on'` under the new one.
    clearDoor();
    locked.current = false;
    setVeil(null);
    saved.current = null;
    setWatch('off');
  }, [liveKey, watch, clearDoor]);

  /** The cut lands: the live block's first line, `--offset-top + 16` from the head. */
  const commitCut = useCallback((): void => {
    const block = document.getElementById('pass');
    if (block !== null) scrollToY(topOf(block) - (headOffset() + 16));
  }, []);

  const enterDoor = useCallback((): void => {
    const block = document.getElementById('pass');
    if (block === null) {
      // The pass's prose is not on the page: call the existing loader once and land on the
      // chapter's head. The door never claims to have arrived (§4).
      if (chapter !== null) {
        if (!loaded.current) {
          loaded.current = true;
          onLoad?.(chapter);
        }
        const head = document.getElementById(`ch-${chapter}`);
        if (head !== null) scrollToY(topOf(head) - headOffset());
      }
      return;
    }
    // BOOK-167: the strip opens on the block the page names, before the cut — the reader
    // arrives at a live row, not at a paragraph that starts being explained afterwards.
    const owner = block.getAttribute('data-pass-block');
    if (chapter !== null && owner !== null) openPassStrip({ chapter, blockId: owner });
    saved.current = { y: window.scrollY, blockId: 'pass', dy: window.scrollY - topOf(block) };
    locked.current = true;
    if (reduced) {
      commitCut();
      setWatch('on');
      locked.current = false;
      return;
    }
    setWatch('entering');
    setVeil('zero');
    doorTimers.current.push(
      window.setTimeout(() => {
        commitCut();
        setWatch('on');
        setVeil('out');
      }, GRIP.commitMs),
    );
    doorTimers.current.push(window.setTimeout(() => setVeil(null), GRIP.commitMs + GRIP.tickMs));
    doorTimers.current.push(
      window.setTimeout(() => {
        locked.current = false;
      }, GRIP.settleMs),
    );
  }, [chapter, commitCut, onLoad, reduced]);

  /** The same door, mirrored: the saved place is re-resolved, not replayed. */
  const leaveDoor = useCallback((): void => {
    const place = saved.current;
    const restore = (): void => {
      if (place !== null) {
        const block = document.getElementById(place.blockId);
        // A revision may have grown the paragraph above: resolve the place, never replay it.
        const target = block !== null ? topOf(block) + place.dy : Math.min(place.y, maxScroll());
        scrollToY(target);
      } else if (chapter !== null) {
        // No place was saved: the chapter's own head is the only honest landing.
        const head = document.getElementById(`ch-${chapter}`);
        if (head !== null) scrollToY(topOf(head) - headOffset());
      }
      saved.current = null;
      setWatch('off');
      // Focus goes back to the door item when it is a real control; when the item has gone
      // inert (the feed emptied under the reader) the nav itself is the only real target, and
      // focus never lands on `document.body` (#156 M2).
      (doorRef.current ?? nav.current)?.focus();
    };
    if (reduced) {
      restore();
      return;
    }
    setVeil('zero');
    doorTimers.current.push(
      window.setTimeout(() => {
        restore();
        setVeil('out');
      }, GRIP.commitMs),
    );
    doorTimers.current.push(window.setTimeout(() => setVeil(null), GRIP.commitMs + GRIP.tickMs));
  }, [chapter, reduced]);

  // A gesture during `entering` clears the veil at once and lands the cut: no finger is ever
  // fought, and the reader's own scroll is never blocked.
  useEffect(() => {
    if (watch !== 'entering') return;
    const clear = (): void => {
      clearDoor();
      locked.current = false;
      commitCut();
      setWatch('on');
      setVeil(null);
    };
    const names = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const;
    for (const name of names) window.addEventListener(name, clear, { passive: true });
    return () => {
      for (const name of names) window.removeEventListener(name, clear);
    };
  }, [watch, clearDoor, commitCut]);

  if (plate) return null;

  const door = passDoor({ ...facts, watching: watch === 'on' });
  const open = grip.open;

  const onDoor = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (watch === 'on') {
      leaveDoor();
      return;
    }
    if (locked.current) return;
    enterDoor();
  };

  return (
    <>
      {veil === null ? null : (
        <div className="foot-veil" data-phase={veil} aria-hidden="true" ref={veilRef} />
      )}
      <nav
        className="foot-jumps"
        aria-label="переходы"
        tabIndex={-1}
        data-open={open ? 'true' : 'false'}
        data-pass={door.state}
        data-watch={watch}
        data-cut={grip.motion === 'cut' ? 'true' : 'false'}
        ref={nav}
        onFocus={(event) => {
          // A keyboard reader who tabs into the nav gets the row at once; a focus the pointer
          // brought with it is not a request (and a tap on a word is a jump, never an expand).
          if (!(event.target instanceof Element) || !event.target.matches('a.foot-jump')) return;
          if (now() - pointerAt.current < 250) return;
          feed({ type: 'focus', atMs: now() });
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          feed({ type: 'blur', atMs: now() });
        }}
        onPointerMove={() => setActivity((n) => n + 1)}
        onPointerDown={() => {
          pointerAt.current = now();
          setActivity((n) => n + 1);
        }}
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
            {door.state === 'absent' ? null : door.href === null ? (
              <span className="foot-jump foot-jump-pass is-inert" aria-label={door.name}>
                <span className="foot-jump-word">{door.label}</span>
                {door.meta === null ? null : <span className="foot-jump-meta">{door.meta}</span>}
              </span>
            ) : (
              <a
                className="foot-jump foot-jump-pass"
                href={door.href}
                aria-label={door.name}
                ref={doorRef}
                // The state table governs the label and the href, never whether the return is
                // reachable: a pass that settles while the reader is inside it still has a way
                // back (#156 M2). A finished pass opens the record's `правка` at its sentence;
                // a modified click keeps the browser's own `?change=` act.
                onClick={
                  door.state === 'record'
                    ? (event) => {
                        // Inside the pass, the same item is the way back, not a second door.
                        if (watch !== 'off') {
                          event.preventDefault();
                          leaveDoor();
                          return;
                        }
                        if (facts.change !== null) plainChangeClick(event, facts.change.id);
                      }
                    : door.state === 'live' || watch !== 'off'
                      ? onDoor
                      : undefined
                }
              >
                <span className="foot-jump-word">{door.label}</span>
                {door.meta === null ? null : <span className="foot-jump-meta">{door.meta}</span>}
              </a>
            )}
          </div>
        </div>
      </nav>
    </>
  );
}
