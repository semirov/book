/**
 * BOOK-209 — the reader's place: one store, one capture, one restore, one resume.
 *
 * Requirement 3 of BOOK-209 is «the reader's place must be remembered», and the remembered thing
 * is an **anchor** (`lib/position.ts`), never a scroll offset: the chapter and sentence the line
 * stands in, plus how far below the line the anchor sat. Local (`localStorage`) and, when signed
 * in, server-side (`GET`/`PUT /api/me/place`), so a second device resumes the same place; the
 * newer row wins by `at`.
 *
 * The four acts this hook owns, and each has exactly one of them:
 *
 *   - **capture**: a `scroll` (one frame per scroll, at most one store write a second and one
 *     `PUT` every 10 s) and the two lifecycle moments — `pagehide` and `visibilitychange` to
 *     `hidden` — write the place. A line no chapter owns (the cover, page 2, the contents, the
 *     end matter) writes **nothing**: a reader who is on the cover keeps the place they had.
 *   - **back/forward**: a capture-phase `click` on a same-document `a[href^="#"]` writes the
 *     place the reader is leaving into the entry they are leaving before the browser navigates,
 *     and `popstate` restores the entry's own place — `resolvePlace` + `landOn(deltaPx)`, the
 *     place the reader left and not the anchor's nominal one. A chapter jump through
 *     `jumpToChapter` (a contents row, a notice, a card's step) records the same place and pushes
 *     a real entry. Not every landing is an entry, and the ones that are not say so by their
 *     caller: `scrollToChapter` (`dom.ts`) only moves the page — a revise seam
 *     (`useRevise.ts`) uses it and leaves no entry behind.
 *   - **resume**: one attempt on the first ready page, from the place read at boot (or the newer
 *     server row): the chapter's mouth first — that jump is what starts its read — then the
 *     paragraph once it arrives, then the sentence and its `deltaPx`. A miss falls back
 *     sentence → paragraph → chapter behind one `console.info` line and nothing the reader sees.
 *     Any gesture before it lands cancels it, and a document that arrived with a fragment or a
 *     mode in the hash is not resumed at all. The browser's own reload restore is `manual`: the
 *     page's answer to a reload is the anchor, never a remembered offset.
 *   - **coordination with the deep link**: `useDeepLink` still owns the fragments, and its
 *     `popstate` gives way when the entry carries a place (`restore`), so a restored place wins
 *     over a nominal anchor and the fragment is not parsed twice.
 */

import { useEffect, useRef, useCallback } from 'react';

import { ApiError, getMyPlace, putMyPlace } from '../api.ts';
import { settleFrontSequence } from '../useFrontSequence.ts';
import { beginLanding, landChapter, landOn, landingLine } from './landing.ts';
import { nextFrame, waitForBlock, PLACE_RETRY_FRAMES } from './place.ts';
import { isPlace, newerPlace, readPlace, writePlace } from './placeStore.ts';
import { followingInk } from './printFollow.ts';
import {
  parseSentenceId,
  paragraphElement,
  placeAtLine,
  resolvePlace,
  sentenceElement,
  type AnchorLevel,
  type Place,
} from './position.ts';
import { useDeepLink } from './useDeepLink.ts';

/** A store write at most once a second; the hook's own throttle, never the store's. */
export const STORE_WRITE_MS = 1_000;
/** A server write at most once every ten seconds (and on `pagehide`). */
export const PUT_MS = 10_000;

/** A gesture that ends a resume: the reader took the page before the landing arrived. */
const INPUT_EVENTS: readonly [string, AddEventListenerOptions][] = [
  ['wheel', { passive: true }],
  ['touchstart', { passive: true }],
  ['pointerdown', { passive: true }],
  ['keydown', { passive: true, capture: true }],
];

/**
 * The place read at boot — **once** per document, and before anything could move: the cover
 * sequence (`shouldRun`) and the resume have to agree about what this page load is, and a write
 * made by the first scroll must not turn a resume into a cover.
 */
let bootPlace: Place | null | undefined;
/** True once this document has spent its one resume. */
let consumed = false;
/**
 * True once this document has reported a place the server refused (`400 BAD_PLACE`). A rejected
 * place is the client's own bug, and one swallowed line hides it forever; one line per document
 * is enough to find it, and no reader ever sees it.
 */
let rejectedLogged = false;

function placeAtBoot(): Place | null {
  if (bootPlace === undefined) bootPlace = readPlace();
  return bootPlace;
}

/** Re-read the store: the boot read happens once per document, and a test loads a second page. */
export function forgetBootPlace(): void {
  bootPlace = undefined;
  consumed = false;
  rejectedLogged = false;
}

/**
 * Is this page load a **resume**? A valid stored place, a hash naming no chapter or mode
 * (`''` — every mode of this page is a fragment), and no resume spent yet. `shouldRun` reads
 * this: a restored place means this load is not the cover, exactly as a deep link is not.
 */
export function resumePending(): boolean {
  if (typeof window === 'undefined') return false;
  if (consumed) return false;
  return placeAtBoot() !== null && window.location.hash === '';
}

/**
 * The place at the landing line right now; `null` where no chapter owns the line.
 *
 * BOOK-209 — the line is `landingLine`, with **no** `ANCHOR_EPS`: the folio adds that rounding
 * to keep its chapter from flickering at the boundary, and a place is not a folio. `deltaPx` is
 * measured from this line and `landOn` puts the anchor back on this same line, so the two
 * directions are one quantity — an eps added on the way in and not on the way out would land
 * every restored place two pixels above the line the reader left.
 */
export function placeNow(doc: Document = document): Place | null {
  return placeAtLine(doc, landingLine(doc));
}

/** The valid place a history entry carries, or `null` (a fresh entry, someone else's state). */
export function placeOfState(state: unknown): Place | null {
  if (state === null || typeof state !== 'object') return null;
  const held = (state as { bookPlace?: unknown }).bookPlace;
  return isPlace(held) ? held : null;
}

/** Write a place into the entry the reader stands on, keeping whatever else that state holds. */
function keepInEntry(place: Place): void {
  try {
    const state: unknown = window.history.state;
    const held = state !== null && typeof state === 'object' && !Array.isArray(state) ? state : {};
    window.history.replaceState({ ...held, bookPlace: place }, '');
  } catch {
    /* a page whose history cannot be written keeps the fragment it has */
  }
}

/** Record where the reader is now: the entry they are leaving, and the store. */
function recordHere(): void {
  const place = placeNow();
  if (place === null) return;
  keepInEntry(place);
  writePlace(place);
}

/**
 * The one history-aware chapter jump (owner, BOOK-209): a contents row, a notice and a card's
 * step all land the chapter's mouth, and all of them leave a real entry behind, so the browser's
 * own back returns the reader to the place they jumped from. `false` when the chapter is not on
 * this page — the caller keeps the browser's own `#ch-N` jump.
 */
export function jumpToChapter(n: number): boolean {
  if (typeof document === 'undefined' || document.getElementById(`ch-${String(n)}`) === null) return false;
  recordHere();
  try {
    window.history.pushState({ bookPlace: null }, '', `#ch-${String(n)}`);
  } catch {
    /* the landing below is still the reader's jump; only the entry is missing */
  }
  landChapter(n);
  return true;
}

/** Restore one entry's place: the anchor first, the line second, instant and then corrected. */
function restorePlace(place: Place): void {
  const resolved = resolvePlace(document, place);
  if (resolved === null) return;
  void landOn(resolved.element, { deltaPx: place.deltaPx });
}

/**
 * Resume one place: the chapter's mouth, the prose it is still reading, the sentence, the delta.
 * The fallback is the chain and nothing else — a sentence that is no longer a sentence is its
 * paragraph, a paragraph the page does not hold is its chapter — and each miss is one line for
 * the operator, never a surface the reader has to dismiss.
 */
async function resumeAt(place: Place, cancelled: () => boolean): Promise<void> {
  const doc = document;
  const chapter = doc.getElementById(`ch-${String(place.chapter)}`);
  if (chapter === null) return;
  const parsed = parseSentenceId(place.sentenceId);
  // The mouth first: a chapter's prose is read when its slot comes near the viewport, so this
  // jump is what starts the read the rest of the resume is waiting for.
  void landOn(chapter, {});
  if (parsed === null || parsed.level === 'chapter') return;
  const block = await waitForBlock({
    scope: chapter,
    find: () => paragraphElement(doc, place.chapter, parsed.blockId),
    frames: PLACE_RETRY_FRAMES,
    wait: nextFrame,
  });
  if (cancelled()) return;
  const sentence = block === null || parsed.level !== 'sentence' ? null : sentenceElement(block, parsed.start);
  const target = sentence ?? block ?? chapter;
  const level: AnchorLevel = target === chapter ? 'chapter' : sentence === null ? 'paragraph' : 'sentence';
  if (level !== parsed.level) {
    console.info(`position: resume fell back ${parsed.level}→${level} ${place.sentenceId}`);
  }
  void landOn(target, { deltaPx: level === 'chapter' ? 0 : place.deltaPx });
}

/** The place to resume, and whether the server's row is the one that won. */
async function pendingPlace(signedIn: boolean): Promise<{ place: Place | null; fromServer: boolean }> {
  const local = placeAtBoot();
  if (!signedIn) return { place: local, fromServer: false };
  let remote: Place | null = null;
  try {
    remote = await getMyPlace();
  } catch {
    // A server that cannot answer is not a reason to lose the place this page already has.
    remote = null;
  }
  const place = newerPlace(local, remote);
  // `newerPlace` keeps the server's row on an equal instant, so a row that arrived and survived
  // the comparison is the one this page resumes — the case a second device is: no local row at
  // all, and a cover that already started because the store could not say otherwise.
  return { place, fromServer: remote !== null && place === remote };
}

/**
 * One `PUT`, never a banner: a place is not worth the reader's attention. A refusal is not the
 * reader's either, but it is the operator's: `400 BAD_PLACE` means this client built a row the
 * server will not take, and a swallowed promise hides that until someone reads the database. One
 * `console.info` line per document, and silence for a network that is simply down.
 */
function pushPlace(place: Place): void {
  void putMyPlace(place).catch((error: unknown) => {
    if (rejectedLogged) return;
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== 'BAD_PLACE') return;
    rejectedLogged = true;
    console.info(`position: the server refused a place (400 BAD_PLACE) ${place.sentenceId}`);
  });
}

/** The reader's own gestures, for the lifetime of the page: a resume dies on the first one. */
function useReaderInput(gesture: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    for (const [name, options] of INPUT_EVENTS) window.addEventListener(name, gesture, options);
    return () => {
      for (const [name, options] of INPUT_EVENTS) window.removeEventListener(name, gesture, options);
    };
  }, [gesture]);
}

/**
 * The page's position layer, called once from `App`. It owns the capture, the history entries and
 * the one resume; the deep link keeps the fragments, with this layer's `restore` seam ahead of it.
 */
export function usePosition(ready: boolean, signedIn: boolean): void {
  /** The signed-in state as of now, read by the capture's `PUT` without re-binding a listener. */
  const signed = useRef(signedIn);
  signed.current = signedIn;
  /** The reader has taken the page: the resume is over before it lands. */
  const taken = useRef(false);
  const resumed = useRef(false);

  /** A `popstate` that carries a place is not a fragment open: the deep link gives way. */
  const restore = useCallback((state: unknown): boolean => placeOfState(state) !== null, []);
  useDeepLink(ready, restore);

  useReaderInput(
    useCallback(() => {
      taken.current = true;
    }, []),
  );

  // The browser's own restore is a remembered pixel; a place is the anchor. Set once, before any
  // landing: a reload then asks the page for the place, not the engine for an offset that the
  // prose has since moved under. An engine without `history` (or one that refuses the order)
  // keeps its own restore, and the page still lands where the text is.
  useEffect(() => {
    if (typeof window === 'undefined' || window.history === undefined) return;
    try {
      window.history.scrollRestoration = 'manual';
    } catch {
      /* a history that will not take the order is the engine's business, not the page's */
    }
  }, []);

  // A page that goes away takes its landings with it: nothing keeps correcting a document gone.
  useEffect(() => () => {
    beginLanding();
  }, []);

  // ── capture ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = 0;
    let trailing = 0;
    let lastWrite = 0;
    let lastPut = 0;
    let latest: Place | null = null;

    /**
     * At most one write a second, with the trailing one kept: the last scroll still lands. The
     * entry the reader is standing on is written with it — the store answers the next page load,
     * the entry answers this page's own back and forward, in **both** directions.
     */
    const hold = (place: Place): void => {
      latest = place;
      const now = Date.now();
      if (now - lastWrite >= STORE_WRITE_MS) {
        lastWrite = now;
        writePlace(place);
        keepInEntry(place);
        return;
      }
      if (trailing !== 0) return;
      trailing = window.setTimeout(() => {
        trailing = 0;
        if (latest === null) return;
        lastWrite = Date.now();
        writePlace(latest);
        keepInEntry(latest);
      }, STORE_WRITE_MS - (now - lastWrite));
    };

    const capture = (): void => {
      const place = placeNow();
      // The cover is not a place: a reader who scrolled up to it keeps the one they had.
      if (place === null) return;
      hold(place);
      if (!signed.current) return;
      const now = Date.now();
      if (now - lastPut < PUT_MS) return;
      lastPut = now;
      pushPlace(place);
    };

    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        capture();
      });
    };

    /** A page that is leaving writes at once: the throttle is for scrolling, not for the end. */
    const flush = (): void => {
      const place = placeNow();
      if (place === null) return;
      latest = null;
      lastWrite = Date.now();
      writePlace(place);
      keepInEntry(place);
      if (signed.current) {
        lastPut = Date.now();
        pushPlace(place);
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      if (trailing !== 0) window.clearTimeout(trailing);
    };
  }, []);

  // ── back/forward ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPop = (event: PopStateEvent): void => {
      const place = placeOfState(event.state);
      // BOOK-220 — a followed print owns the page: the restore would be undone by the control's
      // own scroll in the next frame, so the entry's place is not landed while the ink follows.
      if (place === null || followingInk()) return;
      restorePlace(place);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A same-document anchor: record the place being left **before** the browser navigates.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (anchor === null || anchor.hasAttribute('download')) return;
      if (anchor.target !== '' && anchor.target !== '_self') return;
      if ((anchor.getAttribute('href') ?? '#') === '#') return;
      recordHere();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // ── resume ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || typeof window === 'undefined' || resumed.current) return;
    // BOOK-220 — a follow that is on with a print in flight is the page's answer to "where am I":
    // the ink's line. The one resume is spent unused, so nothing lands under the control later.
    if (followingInk()) {
      resumed.current = true;
      consumed = true;
      return;
    }
    void (async () => {
      const { place, fromServer } = await pendingPlace(signed.current);
      if (taken.current || resumed.current || place === null) return;
      // A load that arrived with a fragment (a chapter, a door, a mode) is not a resume.
      if (window.location.hash !== '') return;
      if (document.getElementById(`ch-${String(place.chapter)}`) === null) return;
      // A second device had no local row at mount, so the cover sequence started; its place only
      // arrives from the server. A resume never lands under a running sequence: the cover
      // finishes whole, and then the page goes to the place the reader left.
      if (fromServer) settleFrontSequence();
      resumed.current = true;
      consumed = true;
      await resumeAt(place, () => taken.current);
    })();
  }, [ready, signedIn]);
}
