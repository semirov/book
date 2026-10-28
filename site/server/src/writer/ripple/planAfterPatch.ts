/**
 * What the writer does with the plan `land` returned (BOOK-173, BOOK-DOC-75 §3, §7).
 *
 * The plan itself is the engine's (`engine/ripple.ts`): it reads the ledger, and the writer owns
 * no database. This module is only the writer's half of the seam — one pure decision and the two
 * reader sentences it can produce, so both are pinned by a test instead of assembled inline in the
 * pass:
 *
 *   · `local`  → nothing claims the change; the pass continues into the gates as it does today;
 *   · `ripple` → the closure stands and fits its bounds; the origin chapter finishes its gates and
 *                the change closes `ripple`, with each consequence its own later pass;
 *   · `wide`   → a bound (money, changed characters, iterations, the node valve) or a reversed
 *                outcome puts the whole closure in front of the author. The pass parks **before**
 *                spending on a chapter, and the point patch stays landed: the decision is about
 *                the rest of the book, never about the sentence that already arrived.
 *
 * No model is called here (the engine's half is deterministic, and the one call of the ripple —
 * the causality judge — is `judge.ts`). `priceOf` is arithmetic from the design's measured
 * per-chapter cost, printed as an estimate, never as a charge.
 */

import type { RipplePlan } from '../../ledger/graph/plan.ts';

/**
 * BOOK-DOC-75 §8, measured: one patched chapter is a patch pass plus a gate pair, $0.11–0.14.
 * The plan is priced at the top of that band so an estimate is never smaller than the bill.
 */
export const RIPPLE_CHAPTER_USD = 0.14;

export type LandingReaction =
  | { kind: 'continue' }
  | { kind: 'ripple'; plan: RipplePlan; line: string }
  | { kind: 'wide'; plan: RipplePlan; sentence: string };

/** The chapters the closure reaches that are not the chapter the patch landed on. */
export function affectedChapters(plan: RipplePlan): number[] {
  return plan.chaptersTouched.filter((chapter) => chapter !== plan.chapter);
}

/** The one chapter the wide sentence names: the nearest consequence, else the origin. */
export function causeChapter(plan: RipplePlan): number {
  const touched = affectedChapters(plan);
  const mandatory = plan.nodes.filter((node) => node.mandatory).map((node) => node.chapter);
  const candidates = mandatory.length > 0 ? mandatory : touched;
  return candidates.length === 0 ? plan.chapter : Math.min(...candidates);
}

/** What the ripple costs at the top of the measured band, rounded to a cent. */
export function priceOf(plan: RipplePlan): number {
  const chapters = new Set(plan.nodes.filter((node) => node.mandatory).map((node) => node.chapter));
  if (chapters.size === 0) return 0;
  return Math.round(chapters.size * RIPPLE_CHAPTER_USD * 100) / 100;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * §7: the `read` line of the origin pass — the plan as one fact the reader can check against the
 * change page. «правка задела 3 главы: 2 обязательных, 1 отсрочиваемая · $0,25».
 */
export function planLine(plan: RipplePlan): string {
  const mandatory = plan.nodes.filter((node) => node.mandatory).length;
  const optional = plan.nodes.length - mandatory;
  return [
    `правка задела ${String(affectedChapters(plan).length)} глав`,
    `${String(mandatory)} обязательных`,
    `${String(optional)} отсрочиваемых`,
    money(priceOf(plan)),
  ].join(' · ');
}

/** The same plan as a clause inside an escalation note: numbers only, no sentence of its own. */
export function planSummary(plan: RipplePlan): string {
  return `${String(affectedChapters(plan).length)} глав, ${String(plan.nodes.filter((node) => node.mandatory).length)} обязательных, ${money(priceOf(plan))}`;
}

/**
 * §3, verbatim: the reader's sentence for a wide. The second clause is the honest part — the
 * point patch is already a revision, and parking must not pretend otherwise.
 */
export function wideSentence(plan: RipplePlan): string {
  return [
    `это меняет причину в главе ${String(causeChapter(plan))} — нужен широкий проход, его решает автор`,
    `правка на месте уже в книге (глава ${String(plan.chapter)}), её не откатываю`,
  ].join(' · ');
}

/**
 * The decision, from the plan the engine froze. A missing plan is `local`: the engine had nothing
 * to plan — no change behind the step, or a landing that moved no block — and invention here would
 * escalate on the strength of a value that does not exist.
 */
export function reactToLanding(plan: RipplePlan | null | undefined): LandingReaction {
  if (plan === null || plan === undefined) return { kind: 'continue' };
  if (plan.outcome === 'ripple') return { kind: 'ripple', plan, line: planLine(plan) };
  if (plan.outcome === 'wide') return { kind: 'wide', plan, sentence: wideSentence(plan) };
  return { kind: 'continue' };
}
