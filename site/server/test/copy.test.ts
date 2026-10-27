import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The copy guard, source half (BOOK-15, BOOK-19).
 *
 * The rendered half is `web/src/components/copyGuard.test.tsx`: it renders every surface that
 * can print a reader-facing line and greps the markup. This half greps the **copy modules**
 * those surfaces render from, so a new string cannot slip in between render tests. The banned
 * words: «шов», «противоречие исправлено», «битый», «retcon», and the name of any gate role —
 * the gates are invisible to readers (invariant 18), and the retrospection is оформляется,
 * never masked.
 */

const ROOT = join(import.meta.dirname, '../..');
const BANNED = ['шов', 'противоречие исправлено', 'битый', 'retcon', 'редактор', 'консультант', 'аудитор'];

const COPY_MODULES = [
  'web/src/lib/changeStatus.ts',
  'web/src/lib/cascade.ts',
  'web/src/lib/deed.ts',
  'web/src/lib/focus.ts',
  'web/src/lib/history.ts',
  'web/src/lib/format.ts',
  'server/src/history/summary.ts',
];

describe('the copy modules a reader sees', () => {
  it('never carry a banned word', () => {
    for (const module of COPY_MODULES) {
      const source = readFileSync(join(ROOT, module), 'utf8').toLowerCase();
      for (const word of BANNED) expect(source, module).not.toContain(word);
    }
  });
});
