/**
 * BOOK-220 — the print harness's probe flag, and nothing a reader can reach.
 *
 * The CDP harness (`scripts/chain-print-cdp.mjs`) needs the engine's own ink times to ask "what
 * could this instant have inked?"; a shipped bundle must not answer that question. The renderer
 * therefore publishes its plan only when the page was opened with `?probe=print` — an explicit
 * flag on the URL the harness owns, never a standing global on a reader's page.
 */

export const PRINT_PROBE_PARAM = 'probe';
export const PRINT_PROBE_VALUE = 'print';

/** Is this page a harness probe? `false` everywhere a reader can be. */
export function printProbeOn(search?: string): boolean {
  const query = search ?? (typeof window === 'undefined' ? '' : window.location.search);
  return new URLSearchParams(query).get(PRINT_PROBE_PARAM) === PRINT_PROBE_VALUE;
}
