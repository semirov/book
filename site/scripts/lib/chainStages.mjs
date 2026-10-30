/**
 * lib/chainStages.mjs — the one import `scripts/chain-print-cdp.mjs` uses.
 *
 * The stages live in two files (the 500-line arch gate): the print's own contract in
 * `chainContract.mjs`, the reduced-motion / arrival / window / perf captures in `chainCapture.mjs`.
 * This barrel keeps the harness's import list stable.
 */

export {
  MAX_CHAIN_GAP_MS,
  MOUNT_MS,
  PRINT_WINDOW_MS,
  SAMPLE_MS,
  WRITE_GAP_MS,
  chain,
  checker,
  printContract,
  twoPlaces,
} from './chainContract.mjs';
export { arrivals, folioGap, perf, reducedMotion, shotter, tooLate } from './chainCapture.mjs';
export { newChapter } from './chainChapter.mjs';

/** The report's own record of the numbers the run is bound by. */
export const STAGE = {
  SAMPLE_MS: 50,
  PRINT_WINDOW_MS: 6_000,
  WRITE_GAP_MS: 1_200,
  MAX_CHAIN_GAP_MS: 1_500,
  ARRIVALS: [0.3, 0.7, 0.95],
  PERF_CHARS: 27_000,
  PERF_MS: 25_000,
};
