/**
 * BOOK-121's cost harness: what one `frameAt` costs on a 100-grapheme plan. No page, no DOM, no
 * dependencies — run from `site/`:
 *
 *   node scripts/pass-perf.ts
 *
 * The loop is the renderer's: 1 000 frames over the plan's own settle, the revealed counts summed
 * so nothing is optimised away. What it measures is the pure frame — the renderer adds one
 * class toggle, one custom-property write and two transforms on top of it.
 */

import { frameAt, planPass } from '../web/src/lib/passMotion.ts';
import { graphemes } from '../web/src/lib/reveal.ts';

const RUN = graphemes(
  'старая река, и вот брод, и снова тихий вечер у воды, и снова тихий вечер у воды, и снова тихий '
    .repeat(2),
).slice(0, 100);
const BEFORE = 'брод был тихим';
/** A hundred-grapheme run over four lines, the block six lines tall. */
const PER = 25;

const plan = planPass({
  kind: 'replacement',
  before: BEFORE,
  after: RUN.join(''),
  layout: {
    linePx: 30.24,
    blockLines: 6,
    runLines: Array.from({ length: RUN.length }, (_, index) => 2 + Math.floor(index / PER)),
    spanStartLine: 2,
    spanLines: 4,
  },
});

const STEPS = 1_000;
const times = Array.from({ length: STEPS }, (_, index) => (index / STEPS) * plan.settleMs);

// One warm-up pass: the first call pays for the JIT, not for the frame.
let sink = 0;
for (const at of times) sink += frameAt(plan, at).revealed;

const started = performance.now();
for (const at of times) sink += frameAt(plan, at).revealed;
const total = performance.now() - started;
const perFrame = total / STEPS;

console.log(
  `frameAt · ${plan.graphemes.length} graphemes · ${plan.settleMs.toFixed(0)} ms plan · ` +
    `${STEPS} frames · ${total.toFixed(2)} ms total`,
);
console.log(`${perFrame.toFixed(4)} ms per 100 graphemes (${(1_000 / perFrame).toFixed(0)} frames/s)`);
console.log(`checksum ${sink}`);
