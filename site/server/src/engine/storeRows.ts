/**
 * The engine's own row shapes (`steps`, `leases`), split from `store.ts` at the arch bound.
 * They are re-exported by `store.ts`, so every caller still imports one module.
 */

export type StepRow = {
  step_id: string;
  cascade_id: string | null;
  seq: number;
  wave: number;
  lane: 'forward' | 'backward' | null;
  pass: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';
  chapter: number | null;
  boundary: string;
  /** BOOK-7 — the premise this draft step consumes; null for every other pass. */
  premise_change: string | null;
  outcome:
    | 'rewritten'
    | 'holds'
    | 'published_with_finding'
    | 'evaluated'
    | 'escalated'
    | 'interrupted'
    | null;
  rev_before: number | null;
  rev_after: number | null;
  seams_in: string | null;
  seams_out: string | null;
  blocks_touched: number | null;
  chars_delta: number | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_rub: number;
  /** BOOK-23: 1 = `cost_rub` is a measurement, 0 = never priced. */
  cost_priced: number;
  hseq_from: number | null;
  hseq_to: number | null;
  lease_id: string | null;
  session: string | null;
  at: string;
  ms: number | null;
  note: string | null;
  cycle: number;
  last_findings: string | null;
  start_sha: string | null;
  landed_at: string | null;
  landed_sha: string | null;
  /** BOOK-222: the text a pass wrote and no close has published yet (`landed_*` = published). */
  candidate_text: string | null;
  candidate_sha: string | null;
  /** BOOK-222: the patch's character edits, held with the candidate and applied at the publish. */
  candidate_sentences: string | null;
  pre_blocks: string | null;
  rights_scan: string | null;         // BOOK-61 — Gate B's scan of the new blocks, as JSON
  closed_at: string | null;
  /** BOOK-117: when the step was re-opened to be closed — the wall's second window. */
  reopened_at: string | null;
  /** §10.8: 1 = the sixth, deterministic attempt; 0 otherwise. */
  desperate: number;
  /** §10.8: the widening code this attempt runs under, null before the third failure. */
  widened: string | null;
};

export type LeaseRow = {
  id: string;
  step_id: string;
  change_id: string | null;
  cascade_id: string | null;
  lane: 'forward' | 'backward' | null;
  chapter: number | null;
  is_front: number;
  kind: 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';
  session: string;
  expected_rev: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
};

