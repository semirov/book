/**
 * BOOK-121's terminal harness: print the three golden fixtures' frames at 0 / 200 / 800 / 1600
 * and at the settle instant. No page, no DOM, no dependencies — run from `site/`:
 *
 *   node scripts/pass-motion.ts
 */

import { frameAt, planPass } from '../web/src/lib/passMotion.ts';
import { PASS_FIXTURES } from '../web/src/lib/passMotionFixtures.ts';

const pad = (value: string, width: number): string => value.padEnd(width).slice(0, width);

for (const fixture of PASS_FIXTURES) {
  const plan = planPass(fixture.input);
  const times = [0, 200, 800, 1600, plan.settleMs];

  console.log(`\n${fixture.name}  ·  settle ${plan.settleMs.toFixed(2)} ms  ·  cps ${plan.cps}`);
  console.log(
    [
      pad('at', 8),
      pad('beat', 9),
      pad('inked', 6),
      pad('selected', 14),
      pad('swapped', 8),
      pad('blue', 7),
      pad('red', 12),
      pad('persist', 8),
      pad('settled', 8),
    ].join(''),
  );
  console.log('-'.repeat(80));

  for (const at of times) {
    const frame = frameAt(plan, at);
    const selected = `${frame.selected ? 'yes' : 'no'} ${frame.selectionOpacity.toFixed(3)}`;
    const blue = frame.blue === null ? '—' : `${frame.blue.line.toFixed(2)}${frame.blue.fading ? '~' : ' '}`;
    const red =
      frame.red === null
        ? '—'
        : `${frame.red.line.toFixed(2)}/${frame.red.col}${frame.red.resting ? ' r' : ''}${frame.red.fading ? '~' : ''}`;
    console.log(
      [
        pad(at.toFixed(at === plan.settleMs ? 2 : 0), 8),
        pad(frame.beat, 9),
        pad(String(frame.revealed), 6),
        pad(selected, 14),
        pad(frame.swapped ? 'yes' : 'no', 8),
        pad(blue, 7),
        pad(red, 12),
        pad(frame.persist ? 'yes' : 'no', 8),
        pad(frame.settled ? 'yes' : 'no', 8),
      ].join(''),
    );
  }
}

console.log('\n(blank = solid, ~ = fading, r = resting)');
