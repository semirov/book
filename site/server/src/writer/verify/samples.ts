/**
 * The sample of `local only` changes (BOOK-173, BOOK-DOC-80 §"The safeguard").
 *
 * A change the full pair never read is not a change nobody re-reads. Two rules decide which
 * local-only changes are queued for the editor, and both are countable:
 *
 *   · every **10th** qualifying change, by the change's own `seq` (the FIFO number, immutable);
 *   · **always the first after a writer boot** — the deploy that changed the judge is the one whose
 *     first read must be checked by a human-grade reader.
 *
 * The boot marker is a `meta` row (`writer_boot`) holding a per-process ULID: written once at boot
 * when no marker stands, and **consumed** by the first local-only change that closes afterwards, so
 * a process that never files one leaves it for the next process rather than swallowing it.
 *
 * The verdicts the audit writes and the drift rule live here too: they are the arithmetic of the
 * same question — «is the judge agreeing with the editor often enough?».
 */

export const SAMPLE_EVERY = 10;
/** `meta` key of the per-process boot marker. */
export const WRITER_BOOT_KEY = 'writer_boot';
/** `writer --audit-samples` drains this many samples unless it is told otherwise. */
export const DEFAULT_AUDIT_SAMPLES = 3;
/** Two disagreements in any window of the last 20 sampled changes: the judge is drifting. */
export const DRIFT_WINDOW = 20;
export const DRIFT_GAPS = 2;
/** The sample's own verdicts, as `change_plans.sample_verdict` stores them. */
export type SampleVerdict = 'ok' | 'gap' | 'error';

/**
 * Should this local-only change be sampled? A pending boot marker wins the tie: it means «the
 * first local-only change of this process», whatever its sequence number is.
 */
export function sampleDue(input: { seq: number; bootPending: boolean }): boolean {
  if (input.bootPending) return true;
  if (!Number.isInteger(input.seq) || input.seq <= 0) return false;
  return input.seq % SAMPLE_EVERY === 0;
}

/** The comparison: Tier 1 said `HOLDS`, the editor said `GAP` — one disagreement. */
export function agreement(editor: 'HOLDS' | 'GAP', tier1: string | null): SampleVerdict {
  if (tier1 !== 'HOLDS') return 'ok';
  return editor === 'HOLDS' ? 'ok' : 'gap';
}

/** The drift test: gaps counted over the newest `DRIFT_WINDOW` samples. */
export function driftDetected(recent: readonly SampleVerdict[]): boolean {
  return recent.slice(0, DRIFT_WINDOW).filter((verdict) => verdict === 'gap').length >= DRIFT_GAPS;
}
