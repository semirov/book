/**
 * BOOK-119 — when the SPA tells the shell's boot guard that the app is alive.
 *
 * `createRoot(...).render(...)` only *schedules* work under React 18: the calling tick ends
 * before a single child exists. Disarming the guard right after the call therefore removed its
 * listeners and its five-second timer while `#root` was still empty — so "the shell loaded, the
 * bundle ran, the render never committed" was a blank page again, the exact class the guard
 * exists to name.
 *
 * The guard is disarmed on a fact, not on a call: the first frame in which the container has a
 * child. The retry stops on either fact —
 *
 *   * the container is no longer in the document → the guard already spoke. Its paint empties the
 *     body (`body.textContent = ''`), which detaches `#root`; a child appearing there afterwards
 *     is invisible to the reader, so disarming would remove the sentence and leave a blank page
 *     again. Stop, and let the sentence stand;
 *   * a child, in a container that is still on the page → the app is alive; call `guard()`, which
 *     drops the guard's frame and its listeners, and stop.
 *
 * No dependency and no timer: one `requestAnimationFrame` per frame, and only until one of those
 * two facts holds.
 */

/** The one browser primitive this needs, injectable so a test can run frames by hand. */
export type FrameScheduler = (callback: () => void) => number;

/** Wait for the container's first child, then disarm the shell's guard once. */
export function disarmAfterMount({
  container,
  guard,
  frames = (callback) => requestAnimationFrame(callback),
}: {
  container: Element;
  guard: () => void;
  frames?: FrameScheduler;
}): void {
  const step = (): void => {
    if (!container.isConnected) return;
    if (container.firstElementChild !== null) {
      guard();
      return;
    }
    frames(step);
  };
  step();
}
