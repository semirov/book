/**
 * The pass's half of tiered verification (BOOK-173, BOOK-DOC-80).
 *
 * Three tiers, in the design's order: Tier 0 is code and always runs; Tier 1 is one small model
 * call over the changed span, and it runs **only if Tier 0 passed** — a countable invariant that
 * broke is a park, not a question for a judge; Tier 2 is the full pair of gates, and the policy
 * (`policy.ts`) says whether the change needs it.
 *
 * The money this module moves is Tier 1's own: one call, bounded at `TIER1_MAX_TOKENS`, priced per
 * call and recorded as `tier1_usd` — the full pair's money is the gates' own and lands where it
 * always did. Tier 1 runs for a **patch** only: a rewrite changed the chapter from its title to its
 * last paragraph, so its span covers both edges and the policy answers `full` without asking
 * whether the prose reads — a question about a span nobody named.
 *
 * A Tier-1 `GAP` on an otherwise local change is carried to the full pair by the policy, never to
 * the reader: the pair is the judge of the judge.
 */

import type { RipplePlan } from '../../ledger/graph/plan.ts';
import type { WriterConfig } from '../config.ts';
import type { WriteMode } from '../mode.ts';
import type { Lane } from '../passLane.ts';
import { costUsd } from '../pipeline.ts';
import { decideGates, gatesLine, gatesWord, type GatesDecision } from './policy.ts';
import { chapterLength, changedRegion, touchedBlocks } from './region.ts';
import { checkTier0, loadLexicon, tier0Detail, type Tier0Result } from './tier0.ts';
import {
  buildTier1Prompt,
  contextOf,
  factSheet,
  judgeLocally,
  tier1VerdictOf,
  TIER1_MAX_TOKENS,
  type Tier1Parse,
} from './tier1.ts';

/** What the close and the transcript record about this change's verification. */
export type GatesRecord = {
  gatesMode: 'local only' | 'full';
  why: string | null;
  tier1Verdict: string | null;
  tier1Usd: number | null;
  /** The one line the record carries: `gates: local only`, or `full` with the trigger named. */
  line: string;
  /** The same fact as the stage summary says it (the summaries are Russian). */
  word: string;
};

export type VerifyOutcome = {
  tier1: Tier1Parse | null;
  tier1Usd: number | null;
  decision: GatesDecision;
  record: GatesRecord;
};

export type VerifyInput = {
  config: WriterConfig;
  bookRoot: string;
  chapter: number;
  /** The pre-image the pass found. */
  before: string;
  /** The text the landing wrote. */
  after: string;
  /** The plan `land` froze; `null` when the engine planned nothing. */
  plan: RipplePlan | null;
  mode: WriteMode | null;
  /** Tier 0, already run by the pass: a failure parks before a byte is written. */
  tier0: Tier0Result;
  lane: Lane;
  log: (line: string) => void;
};

/**
 * Tier 0 on its own, so the pass can run it **before** the write: a countable invariant that
 * breaks must cost nothing but the writing call that produced the text.
 */
export function tier0Of(input: { bookRoot: string; chapter: number; before: string; after: string }): Tier0Result {
  return checkTier0({
    before: input.before,
    after: input.after,
    chapter: input.chapter,
    text: input.after,
    lexicon: loadLexicon(input.bookRoot),
  });
}

function recordOf(decision: GatesDecision, tier1: Tier1Parse | null, tier1Usd: number | null): GatesRecord {
  return {
    gatesMode: decision.gateMode,
    why: decision.why,
    tier1Verdict: tier1 === null ? null : tier1VerdictOf(tier1),
    tier1Usd,
    line: gatesLine(decision),
    word: gatesWord(decision),
  };
}

/**
 * Tier 1 when it can matter, then the table. Tier 0 has already passed — the caller checked it —
 * and a Tier-0 `detail` lives in `tier0Detail` for the park the caller writes.
 */
export async function verifyChange(input: VerifyInput): Promise<VerifyOutcome> {
  const region = changedRegion(input.before, input.after);
  const after = input.after;

  // A rewrite has no span to judge: its region is the chapter, so the policy's edge test decides.
  let tier1: Tier1Parse | null = null;
  let tier1Usd: number | null = null;
  if (input.mode === 'patch') {
    const touched = touchedBlocks(input.before, after, input.chapter).after;
    const prompt = buildTier1Prompt({
      bookRoot: input.bookRoot,
      chapter: input.chapter,
      span: contextOf(after, region).text,
      facts: factSheet(input.plan, touched),
    });
    const run = await judgeLocally({
      prompt,
      ask: (messages) => input.lane.ask('tier1', messages, undefined, { maxTokens: TIER1_MAX_TOKENS }),
      log: input.log,
    });
    tier1 = run.verdict;
    tier1Usd = run.usage === null ? null : costUsd(input.config.pipeline.pricing, run.usage);
  }

  const decision = decideGates({
    tier0: input.tier0,
    tier1: tier1 === null ? null : { verdict: tier1VerdictOf(tier1) },
    plan: input.plan,
    mode: input.mode,
    chapter: input.chapter,
    text: after,
    // A rewrite is measured as the whole chapter: it named no span, and both edges are its own.
    spanStart: input.mode === 'patch' ? region.start : 0,
    spanEnd: input.mode === 'patch' ? region.end : chapterLength(after),
  });
  input.log(`[writer] ${gatesLine(decision)}`);
  return { tier1, tier1Usd, decision, record: recordOf(decision, tier1, tier1Usd) };
}

/** The park detail of a Tier-0 refusal: codes and numbers, never prose. */
export { tier0Detail };
