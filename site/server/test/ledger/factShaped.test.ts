/**
 * The fact-shaped recogniser (ADR-043 D4/D8, L8).
 *
 * The recogniser is the floor under the whole ledger: a token it finds must carry a fact mention,
 * and a token it misses is a hole nothing counts. `19.02` is the case that matters — ADR-043 §2.2
 * names it as a date, and the book's late chapters are written in it — so it is pinned here with
 * the lookalikes that must **not** become dates: a clause number, a percentage, and a full date
 * that would otherwise arrive as a date plus a fragment of itself.
 */

import { describe, expect, it } from 'vitest';

import { findFactShaped, unboundFactShaped } from '../../src/ledger/factShaped.ts';
import { assertFact } from '../../src/ledger/facts.ts';
import { findLiterals } from '../../src/ledger/mentions.ts';
import { AT, ledgerFixture, seedChapter } from './helpers.ts';

function tokens(text: string): Array<[string, string]> {
  return findFactShaped(text).map((token) => [token.kind, token.raw]);
}

describe('the day-and-month date (ADR-043 §2.2)', () => {
  it('reads `19.02` as a date, and writes it as a literal with no year', () => {
    expect(tokens('явление 19.02, каб. 7')).toEqual([['date', '19.02']]);
    expect(findLiterals('явление 19.02')).toEqual([
      { raw: '19.02', literal: '--02-19', kind: 'date', start: 8, end: 13 },
    ]);
  });

  it('keeps a full date whole: one token, not a date plus a fragment', () => {
    expect(tokens('14.09.2065')).toEqual([['date', '14.09.2065']]);
    expect(findLiterals('14.09.2065').map((literal) => literal.literal)).toEqual(['2065-09-14']);
  });

  it('refuses a clause number and a percentage', () => {
    expect(tokens('В соответствии с пунктом 6.2 инструкции')).toEqual([]);
    expect(tokens('п. 4.2, ст. 3.1, рис. 2.1')).toEqual([]);
    expect(tokens('рост 6.2% за год')).toEqual([]);
  });

  it('refuses a day or a month that is not a date', () => {
    expect(tokens('32.02 и 19.13')).toEqual([]);
  });

  it('is counted by the gap, and only a fact mention closes it', () => {
    const fixture = ledgerFixture();
    const [block] = seedChapter(fixture.db, { chapter: 12, texts: ['Явка 19.02, каб. 7.'] });
    expect(unboundFactShaped(fixture.db, 12).count).toBe(1);
    expect(block).toBeDefined();
    const factId = assertFact(fixture.db, { chapter: 12, kind: 'date', statement: 'явка 19.02', term: '19.02', at: AT });
    const bind = fixture.db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, resolved_by_change, role, witness, edge_path)
       VALUES ('ext:ch12:1:0', @blockId, 12, 5, 10, @kind, @factId, NULL, @role, '19.02', '[]')`,
    );
    // A `date` mention is the literal index, not the claim: the guard wants a fact.
    bind.run({ blockId: block?.id ?? '', kind: 'date', factId: null, role: null });
    expect(unboundFactShaped(fixture.db, 12).count).toBe(1);
    bind.run({ blockId: block?.id ?? '', kind: 'fact', factId, role: 'assert' });
    fixture.db.prepare('DELETE FROM mentions WHERE kind = \'date\'').run();
    expect(unboundFactShaped(fixture.db, 12).count).toBe(0);
    fixture.close();
  });
});
