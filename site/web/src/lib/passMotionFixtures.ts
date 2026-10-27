import type { PassPlanInput } from './passMotion.ts';

/**
 * The three golden fixtures of BOOK-121, shared by `passMotion.test.ts` and the terminal
 * harness (`site/scripts/pass-motion.ts`). The words are the spec's own; the counts are the
 * binding ones: 14 old / 23 new graphemes on 1440, 40 new on 390, 14 old on 390. The
 * replacement leaves `cps` out on purpose: 1440 is the desktop default the module must take.
 */

export type PassFixture = { name: string; input: PassPlanInput };

const repeat = (count: number, line: number): number[] => Array.from({ length: count }, () => line);

export const PASS_FIXTURES: readonly PassFixture[] = [
  {
    name: 'replacement · 1440',
    input: {
      kind: 'replacement',
      before: 'брод был тихим',
      after: 'старая река, и вот брод',
      layout: {
        linePx: 30.24,
        blockLines: 6,
        runLines: [...repeat(21, 2), 3, 3],
        spanStartLine: 2,
        spanLines: 2,
      },
    },
  },
  {
    name: 'insertion · 390',
    input: {
      kind: 'insertion',
      before: '',
      after: 'и новый брод, через реку у самых мельниц',
      cps: 34,
      layout: {
        linePx: 28.56,
        blockLines: 8,
        runLines: [...repeat(22, 3), ...repeat(18, 4)],
        spanStartLine: 3,
        spanLines: 1,
      },
    },
  },
  {
    name: 'deletion · 390',
    input: {
      kind: 'deletion',
      before: 'шум реки затих',
      after: '',
      cps: 34,
      layout: {
        linePx: 28.56,
        blockLines: 5,
        runLines: [],
        spanStartLine: 1,
        spanLines: 1,
      },
    },
  },
];
