import { closeOtherOverlays } from './overlayRegistry.ts';
// Side-effect imports: each store hands its own closer to `overlayRegistry.ts` on load, so this
// module can ask for «all of them» without naming a single store.
import './useSeam.ts';
import './useFiling.ts';
import './useRevision.ts';
import './usePassStrip.ts';

/**
 * BOOK-111 (owner, 2026-10-27) — the page holds one overlay at a time.
 *
 * Entering the прицел is the one act that must clear all three: the seam, the panel and the
 * revision object go, so the lit sheet is the only surface and nothing half-written is left
 * behind it. Nothing is destroyed by it — a draft lives in `draft.ts` and is found again when
 * its seam reopens (`BOOK-33`).
 */
export function closeOverlays(): void {
  closeOtherOverlays(null);
}
