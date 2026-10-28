/**
 * BOOK-128 comment #3852 — the reader's line must not move when the block opens.
 *
 * The block is a sibling **after** the paragraph, so the line the reader touched never moves;
 * what moves is everything below the block. `record.css` states `overflow-anchor: auto` on the
 * reading column and `overflow-anchor: none` on the record, so where an engine anchors by itself
 * the paragraph — never the block — is the anchor. Engines do not anchor an **animated**
 * `grid-template-rows` disclosure, and not at every scroll position, so the position is also
 * measured here and put back by the loop below.
 *
 * So the contract is measured, not assumed: the reading line is read once when the block mounts
 * and once per frame while its height lands; the distance from the place it had is taken back
 * with one **instant** `scrollBy` (never `smooth`, never a second animation). Because the
 * correction is absolute — «the line belongs at `target`» — an engine that already anchored the
 * position has a delta of zero and the `scrollBy` never runs: the same loop is the contract on
 * both kinds of engine.
 *
 * The loop ends when the block's height has been still for a few frames, when the caller
 * releases it, on the reader's own scroll (a gesture wins over a correction it did not make),
 * or after a bounded window.
 */
/**
 * The correction is snapped to the engine's **device-pixel grid**: a browser whose scroll
 * offsets are whole pixels ignores a `scrollBy(0.59)` outright, and the line keeps a sub-pixel
 * error forever. The step is therefore a whole quantum, and the loop stops at half of it — the
 * design's own bound (0.5 px at 1×, 0.25 at 2×).
 */
function quantumOf(): number {
  if (typeof window === 'undefined') return 1;
  return Math.max(1 / (window.devicePixelRatio || 1), 1 / 8);
}
/** Height is final when it stops changing; a sub-pixel flutter is not a change. */
const STILL = 0.5;
/** A hard bound, not a schedule: the loop normally ends with the disclosure. */
const WINDOW_MS = 2500;

type Probe = { element: HTMLElement; top: number };

/**
 * The first prose block the reader can see — the line being read. Several heights are tried
 * because the top of the viewport may be the site's own chrome, the block that is opening, or
 * the gap above a paragraph; the block itself is never a probe (its own height is the change).
 */
function probeOf(): Probe | null {
  if (typeof document === 'undefined') return null;
  // jsdom and any engine without hit-testing: there is no line to hold, and no layout to hold
  // it in — the block still opens, it simply has nothing to compensate.
  if (typeof document.elementsFromPoint !== 'function') return null;
  const x = Math.max(1, Math.round((window.innerWidth || 390) / 2));
  for (const fraction of [0.06, 0.3, 0.55, 0.8]) {
    const y = Math.max(1, Math.round((window.innerHeight || 800) * fraction));
    for (const node of document.elementsFromPoint(x, y)) {
      if (node.closest('.rec') !== null) continue;
      const element = node.closest<HTMLElement>('.p, .ch-title, .ch-h, .discussion-row, li');
      if (element === null) continue;
      return { element, top: element.getBoundingClientRect().top };
    }
  }
  return null;
}

/** Hold the reading line from now until the returned release, or until the block settles. */
export function holdAnchor(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const probe = probeOf();
  if (probe === null) return () => undefined;
  const QUANTUM = quantumOf();
  const TOLERANCE = QUANTUM / 2;
  const block = document.querySelector<HTMLElement>('.rec');
  if (block === null) return () => undefined;

  /** The place the line must keep — the reading position, not «where it was last frame». */
  const target = probe.top;
  let stopped = false;
  let still = 0;
  let height = -1;
  let frame = 0;
  const started = performance.now();

  /** How far the reading line is from its place right now. */
  const offset = (): number => {
    if (!probe.element.isConnected) return 0;
    return probe.element.getBoundingClientRect().top - target;
  };

  const stop = (): void => {
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchmove', stop);
  };
  // The reader's own scroll wins: a wheel or a finger ends the hold at once.
  window.addEventListener('wheel', stop, { passive: true });
  window.addEventListener('touchmove', stop, { passive: true });

  const tick = (): void => {
    if (stopped) return;
    if (performance.now() - started > WINDOW_MS) return;
    const now = block.isConnected ? block.getBoundingClientRect().height : 0;
    still = Math.abs(now - height) <= STILL ? still + 1 : 0;
    height = now;
    // Up to three rounds in the same task: one quantum per round, then a fresh measurement. A
  // single step can land on the other side of the target (or be swallowed by the engine's
  // scroll snapping), and the contract is the *residual*, not the step.
    for (let round = 0; round < 3; round += 1) {
      const delta = offset();
      if (Math.abs(delta) <= TOLERANCE) break;
      // One whole quantum in the needed direction: a fractional `scrollBy` is a no-op on an
      // engine that snaps its scroll offsets, and a 0.59 px error would outlive the block.
      const step = Math.abs(delta) >= QUANTUM ? Math.round(delta / QUANTUM) * QUANTUM : Math.sign(delta) * QUANTUM;
      window.scrollBy({ top: step, behavior: 'auto' });
    }
    // Six still frames after the disclosure has finished: the height is final, and the line has
    // been put back by the correction above.
    if (still >= 8 && Math.abs(offset()) <= TOLERANCE) {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return stop;
}
