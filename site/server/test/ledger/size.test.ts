import { afterEach, describe, expect, it } from 'vitest';

import { backfillLegacySpans } from '../../src/db/migrateV22.ts';
import { ledgerFixture, seedChapter, type LedgerFixture } from './helpers.ts';

/**
 * BOOK-DOC-69 / ADR-043 ask one question of the ledger that only a measurement answers: what do
 * the three levels cost? This test writes the shape prod has (thousands of paragraphs of real
 * length), backfills it, and reports **both** storages per chapter — the change span (`spans`,
 * one per version) and the checkpoint (`text`, one per eight versions). The bounds are
 * deliberately wide: the number is a budget input, not a contract, and a rewrite that stores a
 * whole chapter per revision would break them by an order of magnitude.
 */

const CHAPTERS = 2;
const BLOCKS = 40;
const BLOCK_CHARS = 400;

function paragraph(chapter: number, index: number): string {
  let text = `Служебный абзац ${String(chapter)}.${String(index)}: `;
  const filler = 'Служебный текст для проверки объёма, он не является текстом книги. ';
  while (text.length < BLOCK_CHARS) text += filler;
  return text.slice(0, BLOCK_CHARS);
}

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

describe('the ledger footprint', () => {
  it('stores roughly a span per block, not a snapshot per block', () => {
    fixture = ledgerFixture();
    const { db } = fixture;
    for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
      const texts = Array.from({ length: BLOCKS }, (_, index) => paragraph(chapter, index));
      seedChapter(db, { chapter, texts });
    }

    backfillLegacySpans(db);

    const rows = db
      .prepare(
        `SELECT chapter,
                SUM(LENGTH(spans)) AS chars,
                SUM(LENGTH(CAST(spans AS BLOB))) AS bytes,
                SUM(LENGTH(text)) AS textChars,
                SUM(LENGTH(CAST(text AS BLOB))) AS textBytes,
                SUM(CASE WHEN text != '' THEN 1 ELSE 0 END) AS checkpoints,
                COUNT(*) AS versions
           FROM block_versions GROUP BY chapter ORDER BY chapter`,
      )
      .all() as Array<{
        chapter: number;
        chars: number;
        bytes: number;
        textChars: number;
        textBytes: number;
        checkpoints: number;
        versions: number;
      }>;
    expect(rows).toHaveLength(CHAPTERS);
    for (const row of rows) {
      expect(row.versions).toBe(BLOCKS);
      // Every version carries exactly one legacy span whose insert is the block's text.
      expect(row.chars).toBeGreaterThan(BLOCKS * BLOCK_CHARS);
      // The baseline checkpoint is one per block, not one per version.
      expect(row.checkpoints).toBe(BLOCKS);
    }
    const perChapter = (pick: (row: (typeof rows)[number]) => number): number =>
      Math.round(rows.reduce((sum, row) => sum + pick(row), 0) / CHAPTERS);
    const spansChars = perChapter((row) => row.chars);
    const spansBytes = perChapter((row) => row.bytes);
    const textBytes = perChapter((row) => row.textBytes);
    console.log(
      `ledger size (chars): spans ${String(spansChars)}/chapter · checkpoints ${String(perChapter((row) => row.textChars))}/chapter`,
    );
    console.log(
      `ledger size (bytes): spans ${String(spansBytes)}/chapter · checkpoints ${String(textBytes)}/chapter ` +
        `(${String(CHAPTERS)} chapters × ${String(BLOCKS)} blocks × ${String(BLOCK_CHARS)} chars)`,
    );
    // The span repeats the text and adds its envelope; the checkpoint holds the text once per
    // block. A whole-chapter copy **as ledger rows** per revision would dwarf both — which is why
    // the chapter's copy lives in the `versions/` store as a file (BOOK-187), not in a table.
    expect(spansBytes).toBeGreaterThan(10_000);
    expect(spansBytes).toBeLessThan(BLOCKS * BLOCK_CHARS * 8);
    // One copy of the prose per block (UTF-8 Cyrillic is 2 bytes a character), and never more
    // than the spans that carry the same text plus their envelope.
    expect(textBytes).toBeGreaterThan(BLOCKS * BLOCK_CHARS);
    expect(textBytes).toBeLessThan(spansBytes);
  });
});
