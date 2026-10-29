/**
 * The mode, the price and the refusals (ADR-040 §4, BOOK-174) — **pure**: no database, no clock,
 * no model. Everything it needs is handed in, so a decision can be replayed from the plan row
 * years later and produce the same three values (`mode`, `price`, `refused`).
 *
 * The one idea worth restating: **discovery is free, execution is what costs** (§3.3). The graph
 * may say «this touches twelve chapters», and the answer is not «twelve is too many to look at» —
 * it is «seven of them are lies, five are tone» (§4.1). So the caps below bound what may be
 * patched **automatically**: ≤5 chapters, ≤5 patches, ≤4,000 changed characters, ≤$0.60. Beyond
 * any of them, or when the change would reverse an outcome, lose a lane, lose a chapter's
 * irreversible row, cost an unpriced model or fail to reach a fixpoint, the change is `wide`: the
 * full mandatory set, priced, waiting for **two** signatures — the author's (meaning) and the
 * auditor's (money and scope) (§4.4). An unapproved `wide` plan is refused, not run smaller.
 *
 * Optional nodes never widen a change (§4.1): they are listed and deferred, and the price counts
 * only the mandatory chapters.
 */

import { partsOf } from './parts.ts';
import { pluralAcc } from './plural.ts';
import type { ClosureNode } from './closure.ts';

/** The execution budget, frozen into the plan row at estimate time (§4.1, §5.1). */
export type Bounds = { maxChapters: 5; maxPatches: 5; maxChangedChars: 4000; maxUsd: 0.6 };

export const BOUNDS: Bounds = { maxChapters: 5, maxPatches: 5, maxChangedChars: 4000, maxUsd: 0.6 };

export type Mode = 'local' | 'ripple' | 'wide';

export type RefusalCode = 'CLOSURE_TOO_WIDE' | 'CAUSE_MISSING' | 'CLOSURE_UNSTABLE';

export type Refusal = { code: RefusalCode; sentence: string };

export type ModeInput = {
  /** The chapter the change lands in. */
  origin: number;
  /** The whole closure, both directions — never a window (§3.1). */
  nodes: ClosureNode[];
  /** Fact ids whose text becomes false. A node in `origin` is the change itself. */
  mandatory: string[];
  /** Fact ids with no support left — they must be patched or the book is lying. */
  orphaned: string[];
  /** The facts the patch moves. */
  touched: string[];
  /** A registered edge crossing the origin boundary touches a changed fact. */
  crossingEdge: boolean;
  changedChars: number;
  outcomeReversed: boolean;
  laneLost: boolean;
  irreversibleLost: boolean;
  /** The model has a rate (`cost_priced = 1`); an unpriced change cannot be budgeted. */
  priced: boolean;
  /** A node that came back mandatory through the edge that was meant to repair it (§4.3). */
  unstable: null | { node: string; cycle: string[] };
  /**
   * The chapters this plan actually executes (`graph closure --apply`). Absent or null means the
   * plan's own set — the origin for `local`, every priced chapter otherwise — which is what the
   * engine does when the author presses «apply all». Naming a narrower set is how a caller asks
   * «what if only these chapters move?», and it is the only way a mandatory node can end up
   * unpatched: a mandatory node is refused, never quietly deferred (§4.2).
   */
  applied?: readonly number[] | null;
  approvals?: { author: boolean; auditor: boolean };
};

export type PriceChapter = { chapter: number; facts: string[]; patches: number; usd: number };

export type Price = {
  usd: number;
  chapters: number;
  patches: number;
  changedChars: number;
  priced: boolean;
  byChapter: PriceChapter[];
  assumptions: string[];
};

export type Decision = { mode: Mode; refused: Refusal | null; reasons: string[]; price: Price };

/** ADR-040 §4.6 unit prices — the units, not its rounded aggregate examples. */
const PATCH_USD = 0.02;
const GATES_USD = 0.06;
const JUDGE_USD = 0.01;
const WHOLE_BOOK_USD = 0.09;
const CHAPTER_USD = PATCH_USD + GATES_USD;

const round = (value: number): number => Math.round(value * 100) / 100;

/** The public facts of a refusal, in ADR-040 §6's words, with this plan's numbers in them. */
const SENTENCES = {
  // ADR-040 §6 hard-codes «12 глав … 7»: the number and the noun's form were both baked into the
  // example. The wording is kept, the noun is declined in the accusative — the verb governs it,
  // `задевает 1 главу`, `4 главы`, `12 глав` — and the counts come from the plan: a deliberate
  // grammar fix of the template, not a new sentence.
  tooWide: (chapters: number, mandatory: number, bound: number): string =>
    `правка задевает ${String(chapters)} ${pluralAcc(chapters, 'главу', 'главы', 'глав')}, ` +
    `обязательных из них — ${String(mandatory)}; автоматически правится не больше ${String(bound)}, ` +
    `дальше решает автор`,
  causeMissing: (nodeChapter: number | null, origin: number): string =>
    nodeChapter === null
      ? `следствие осталось без причины: глава ${String(origin)} больше её не даёт`
      : `следствие в главе ${String(nodeChapter)} осталось без причины: глава ${String(origin)} больше её не даёт`,
  unstable: (chapter: number | null, causeChapter: number): string =>
    chapter === null
      ? `правка ходит по кругу: обязательный узел снова обязателен после своей же правки — ` +
        `причина в главе ${String(causeChapter)}`
      : `правка ходит по кругу: глава ${String(chapter)} снова обязательна после своей же правки — ` +
        `причина в главе ${String(causeChapter)}`,
} as const;

/** The price of one change (§4.6): the origin chapter, every mandatory chapter, and the reads. */
export function priceOf(input: ModeInput): Price {
  const chaptersOf = new Map<number, string[]>();
  for (const id of [...input.mandatory].sort()) {
    const node = input.nodes.find((entry) => entry.factId === id);
    const chapter = node?.chapter ?? input.origin;
    const list = chaptersOf.get(chapter) ?? [];
    list.push(id);
    chaptersOf.set(chapter, list);
  }
  // The origin is always patched — it is the change — even when no mandatory node sits in it.
  if (!chaptersOf.has(input.origin)) chaptersOf.set(input.origin, []);

  const chapters = [...chaptersOf.keys()].sort((left, right) => left - right);
  const byChapter: PriceChapter[] = chapters.map((chapter) => ({
    chapter,
    facts: (chaptersOf.get(chapter) ?? []).sort(),
    patches: 1,
    usd: CHAPTER_USD,
  }));
  const crossesPart = partsOf(chapters).length > 1;
  const usd = round(CHAPTER_USD * chapters.length + JUDGE_USD + (crossesPart ? WHOLE_BOOK_USD : 0));

  const assumptions = [
    `patch pass $${PATCH_USD.toFixed(2)} + gates $${GATES_USD.toFixed(2)} per patched chapter = $${CHAPTER_USD.toFixed(2)}`,
    `one causality judge call per change = $${JUDGE_USD.toFixed(2)}`,
    'the closure walk is $0.00 — no model calls',
    'one patch pass per patched chapter',
  ];
  if (crossesPart) {
    assumptions.push(`whole-book read $${WHOLE_BOOK_USD.toFixed(2)}: the closure crosses a part boundary`);
  }
  // The two losses are `wide` predicates, not priced units: E1 is one query over `lane_progress`
  // and S6 one over `irreversible_changes` (ADR-040 §3.2), so they are named at $0.00 rather than
  // silently absent from a price that was computed while they were known to be lost.
  if (input.laneLost) assumptions.push('lost lane: the finale reach (E1) is one ledger query, $0.00');
  if (input.irreversibleLost) assumptions.push('lost irreversible row: the necessity check (S6) is one ledger query, $0.00');
  assumptions.push('estimates on stated unit prices (ADR-040 §4.6), not a measurement');

  return {
    usd,
    chapters: chapters.length,
    patches: chapters.length,
    changedChars: input.changedChars,
    priced: input.priced,
    byChapter,
    assumptions,
  };
}

/**
 * The decision. The mode is the promise before the work (§4.1); the reasons are the facts it was
 * read from, one per predicate, so a reviewer can disagree with a number instead of a verdict.
 *
 * Refusals are checked in one fixed order — instability, then the budget, then a lost cause —
 * because the first one makes the plan meaningless, the second sends it to a human, and the third
 * says the plan itself is incomplete.
 */
export function decide(input: ModeInput): Decision {
  const price = priceOf(input);
  const byId = new Map(input.nodes.map((node) => [node.factId, node]));
  const chapterOf = (id: string): number | null => byId.get(id)?.chapter ?? null;
  const reasons: string[] = [];

  const mandatoryOutside = input.mandatory.filter((id) => chapterOf(id) !== input.origin);
  const orphanOutside = input.orphaned.filter((id) => chapterOf(id) !== input.origin);
  const local = mandatoryOutside.length === 0 && !input.crossingEdge && orphanOutside.length === 0;

  // `wide` is «any of» (§4.1): a change that would reverse an outcome, lose a lane, cost an
  // unpriced model or fail its fixpoint is wide even when it never leaves the origin chapter.
  const oversize = collectWide(input, price);
  let mode: Mode;
  if (oversize.length > 0) {
    mode = 'wide';
    reasons.push(...oversize);
  } else if (local) {
    mode = 'local';
    reasons.push(`local: no mandatory node outside chapter ${String(input.origin)}, no crossing edge, no orphan`);
  } else {
    mode = 'ripple';
    reasons.push(
      `chapters ${String(price.chapters)} ≤ ${String(BOUNDS.maxChapters)}`,
      `patches ${String(price.patches)} ≤ ${String(BOUNDS.maxPatches)}`,
      `changed chars ${String(price.changedChars)} ≤ ${String(BOUNDS.maxChangedChars)}`,
      `price $${price.usd.toFixed(2)} ≤ $${BOUNDS.maxUsd.toFixed(2)}`,
      'priced, stable, no outcome reversed, no lane or irreversible row lost',
    );
  }

  // The plan executes its own chapter set unless the caller names one (`--apply`). A narrower set
  // is how a mandatory node becomes unpatched — and a mandatory node is never deferred (§4.2).
  const executed =
    input.applied === undefined || input.applied === null
      ? new Set(mode === 'local' ? [input.origin] : price.byChapter.map((entry) => entry.chapter))
      : new Set(input.applied);
  const unpatched = input.orphaned.filter((id) => {
    const chapter = chapterOf(id);
    return chapter === null || !executed.has(chapter);
  });

  const refused = refusalOf(input, mode, unpatched, chapterOf);
  if (refused !== null) reasons.push(`refused: ${refused.code}`);
  return { mode, refused, reasons, price };
}

/** Every predicate that sends this change to `wide`, in a fixed order — empty means `ripple`. */
function collectWide(input: ModeInput, price: Price): string[] {
  const over: string[] = [];
  if (price.chapters > BOUNDS.maxChapters) {
    over.push(`chapters ${String(price.chapters)} > ${String(BOUNDS.maxChapters)}`);
  }
  if (price.patches > BOUNDS.maxPatches) over.push(`patches ${String(price.patches)} > ${String(BOUNDS.maxPatches)}`);
  if (input.changedChars > BOUNDS.maxChangedChars) {
    over.push(`changed chars ${String(input.changedChars)} > ${String(BOUNDS.maxChangedChars)}`);
  }
  if (price.usd > BOUNDS.maxUsd) over.push(`price $${price.usd.toFixed(2)} > $${BOUNDS.maxUsd.toFixed(2)}`);
  if (input.outcomeReversed) over.push('an outcome is reversed');
  if (input.laneLost) over.push('a lane no longer reaches the finale');
  if (input.irreversibleLost) over.push('a patched chapter lost its irreversible change');
  if (!input.priced) over.push('unpriced: the model has no rate');
  if (input.unstable !== null) over.push(`unstable: ${input.unstable.node} in ${input.unstable.cycle.join(' → ')}`);
  return over;
}

function refusalOf(
  input: ModeInput,
  mode: Mode,
  unpatched: readonly string[],
  chapterOf: (id: string) => number | null,
): Refusal | null {
  if (input.unstable !== null) {
    const unstable = input.unstable;
    const cause = unstable.cycle.map(chapterOf).find((chapter): chapter is number => chapter !== null) ?? input.origin;
    return {
      code: 'CLOSURE_UNSTABLE',
      sentence: SENTENCES.unstable(chapterOf(unstable.node), cause),
    };
  }

  // A `wide` plan is refused **for being unapproved**, never for being wide: the budget is what
  // made it wide, and the two signatures are what may open it (§4.4). Both, never one.
  const closureChapters = new Set(input.nodes.map((node) => node.chapter));
  const approved = input.approvals?.author === true && input.approvals?.auditor === true;
  if (mode === 'wide' && !approved) {
    return {
      code: 'CLOSURE_TOO_WIDE',
      sentence: SENTENCES.tooWide(closureChapters.size, input.mandatory.length, BOUNDS.maxChapters),
    };
  }

  if (unpatched.length > 0) {
    const chapter = chapterOf([...unpatched].sort()[0] ?? '');
    return { code: 'CAUSE_MISSING', sentence: SENTENCES.causeMissing(chapter, input.origin) };
  }
  return null;
}
