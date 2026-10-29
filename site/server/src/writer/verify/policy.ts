/**
 * Which gates a change needs (BOOK-173, BOOK-DOC-80 §"Tier 2 triggers").
 *
 * One table, four triggers, and the honest default: when none of them holds the full pair is
 * **not** run and the record says `gates: local only` — a fact about the change, not a silence.
 *
 * The triggers, in the design's order:
 *
 *   1. Tier 0 failed (a countable invariant broke — parking is the pass's move, not the pair's);
 *   2. Tier 1 said `GAP`, or answered something nobody could parse (`TIER1_UNPARSED` counts as GAP);
 *   3. Tier 1 said `UNSURE`;
 *   4. the closure is non-empty — the change reaches another node (`mandatory + optional > 0`),
 *      or it cannot be shown to be empty: a patch with no plan is a cascade landing;
 *   5. the changed span lies in the chapter's first or last 600 characters: an opening or a close
 *      is structure, not a sentence;
 *   6. the plan's outcome is `wide`.
 *
 * The edge test reads the **changed span's own offsets** in the chapter, never the chapter's
 * length alone: a patch in the middle of a long chapter is local however long the chapter is.
 */

import type { RipplePlan } from '../../ledger/graph/plan.ts';
import type { WriteMode } from '../mode.ts';
import { chapterLength } from './region.ts';
import type { Tier1Verdict } from './tier1.ts';

/** BOOK-DOC-80: «the chapter's first or last 600 characters». */
export const EDGE_CHARS = 600;

export type GateTrigger =
  | 'tier0_failed'
  | 'tier1_gap'
  | 'tier1_unsure'
  | 'closure_non_empty'
  | 'chapter_edge'
  | 'wide';

export type GatesMode = 'local only' | 'full';

export type GatesDecision = { gateMode: GatesMode; why: GateTrigger | null };

export type DecideInput = {
  /** Tier 0's own result; only `ok` is read here (a failure parks before this table is asked). */
  tier0: { ok: boolean };
  /** The local judge's verdict; `null` when it was not asked (a rewrite has no span to judge). */
  tier1: { verdict: Tier1Verdict } | null;
  plan: RipplePlan | null;
  /** How the pass wrote; `null` for a step with no mode (a resumed step, a draft). */
  mode: WriteMode | null;
  chapter: number;
  /** The chapter as it stands after the landing — the edge test needs its length. */
  text: string;
  /** Code-point offsets of the changed region in `text`. */
  spanStart: number;
  spanEnd: number;
};

const FULL = (why: GateTrigger): GatesDecision => ({ gateMode: 'full', why });

/** The table. First match wins; the order is the design's, and it is a test's table row each. */
export function decideGates(input: DecideInput): GatesDecision {
  if (!input.tier0.ok) return FULL('tier0_failed');
  if (input.tier1 !== null && (input.tier1.verdict === 'GAP' || input.tier1.verdict === 'TIER1_UNPARSED')) {
    return FULL('tier1_gap');
  }
  if (input.tier1 !== null && input.tier1.verdict === 'UNSURE') return FULL('tier1_unsure');
  // A **patch** with no plan is a cascade landing (the ripple plans once, for the origin) or a
  // patch over the rewrite bound. Either way the closure is unknown, and an unknown closure cannot
  // be proven local — the pair runs, exactly as it does for a closure somebody counted.
  if (input.plan === null && input.mode === 'patch') return FULL('closure_non_empty');
  // `mandatory + optional > 0`: every node of the plan is one or the other.
  if (input.plan !== null && input.plan.nodes.length > 0) return FULL('closure_non_empty');
  const length = chapterLength(input.text);
  if (input.spanStart < EDGE_CHARS || input.spanEnd > length - EDGE_CHARS) return FULL('chapter_edge');
  if (input.plan !== null && input.plan.outcome === 'wide') return FULL('wide');
  return { gateMode: 'local only', why: null };
}

/** The reason as the reader's page says it: a word, not a code. */
export const TRIGGER_WORDS: Record<GateTrigger, string> = {
  tier0_failed: 'счётные проверки',
  tier1_gap: 'местный судья нашёл разрыв',
  tier1_unsure: 'местный судья не уверен',
  closure_non_empty: 'правка задела другие узлы',
  chapter_edge: 'правка у края главы',
  wide: 'план широкий',
};

/** The one line the record carries: `gates: local only`, or `full` with the trigger named. */
export function gatesLine(decision: GatesDecision): string {
  if (decision.gateMode === 'local only') return 'gates: local only';
  return `gates: full (${decision.why === null ? 'resumed step' : (TRIGGER_WORDS[decision.why] ?? decision.why)})`;
}

/** The same fact on the reader's stage line: the stage summaries are Russian. */
export function gatesWord(decision: GatesDecision): string {
  if (decision.gateMode === 'local only') return 'гейты: локально';
  return `гейты: полная пара (${decision.why === null ? 'шаг возобновлён' : (TRIGGER_WORDS[decision.why] ?? decision.why)})`;
}
