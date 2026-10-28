import { afterEach, describe, expect, it } from 'vitest';

import { applyPatch } from '../../src/ledger/applier.ts';
import { findLiterals } from '../../src/ledger/mentions.ts';
import { searchBlocks, searchExpression } from '../../src/ledger/search.ts';
import { assertFact } from '../../src/ledger/facts.ts';
import { ledgerFixture, NOW_MS, seedChapter, type LedgerFixture } from './helpers.ts';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

const KEPT = 'Нетронутая строчка: служебный текст остаётся на месте.';
const EDITED = 'Старая фраза стоит здесь.';

describe('searchBlocks — the mirror follows the text', () => {
  it('finds the new phrase and stops finding the old one, while an untouched block is still found', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [KEPT, EDITED] });
    const edited = seeded[1];
    if (edited === undefined) throw new Error('fixture did not seed the second block');

    expect(searchBlocks(db, 'старая фраза').map((hit) => hit.blockId)).toEqual([edited.id]);
    expect(searchBlocks(db, 'нетронутая строчка')).toHaveLength(1);

    const applied = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: edited.id, oldText: 'Старая фраза', newText: 'Новая фраза' }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(applied.ok).toBe(true);

    expect(searchBlocks(db, 'новая фраза')).toHaveLength(1);
    expect(searchBlocks(db, 'старая фраза')).toHaveLength(0);
    expect(searchBlocks(db, 'нетронутая строчка')).toHaveLength(1);
    expect(searchBlocks(db, '')).toHaveLength(0);
    // A reader's punctuation is not FTS syntax: it must find nothing, not raise.
    expect(() => searchBlocks(db, '(')).not.toThrow();
    expect(searchBlocks(db, '-')).toHaveLength(0);
    expect(searchExpression('  ')).toBeNull();
  });
});

describe('literals and fact mentions of an inserted text', () => {
  it('normalises a document number and a date, and binds both as mentions', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [KEPT] });
    const block = seeded[0];
    if (block === undefined) throw new Error('fixture did not seed a block');

    expect(findLiterals('дело 65/11877/арх от 14.09.2065 и 2065-09-14')).toEqual([
      { raw: '65/11877/арх', literal: '65-11877-арх', kind: 'document', start: 5, end: 17 },
      { raw: '14.09.2065', literal: '2065-09-14', kind: 'date', start: 21, end: 31 },
      { raw: '2065-09-14', literal: '2065-09-14', kind: 'date', start: 34, end: 44 },
    ]);

    const applied = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: {
        mode: 'patch',
        edits: [{ blockId: block.id, oldText: 'служебный текст', newText: 'дело 65/11877/арх от 14.09.2065' }],
      },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(applied).toMatchObject({ ok: true, literals: 2, mentions: 2 });

    const literals = db
      .prepare('SELECT literal, raw, mention_kind, chapter FROM literals ORDER BY literal')
      .all() as Array<{ literal: string; raw: string; mention_kind: string; chapter: number }>;
    expect(literals.map((row) => row.literal)).toEqual(['2065-09-14', '65-11877-арх']);
    expect(literals.map((row) => row.mention_kind)).toEqual(['date', 'document']);
    expect(literals.every((row) => row.chapter === 8)).toBe(true);
    const kinds = db.prepare('SELECT kind FROM mentions ORDER BY kind').all() as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(['date', 'document']);
    // The offsets are code points inside the block, and they point at the literal itself.
    const document = db.prepare(`SELECT start, end FROM mentions WHERE kind = 'document'`).get() as {
      start: number;
      end: number;
    };
    const text = (db.prepare('SELECT text FROM blocks WHERE idx = 0 AND chapter = 8').get() as { text: string }).text;
    expect(Array.from(text).slice(document.start, document.end).join('')).toBe('65/11877/арх');
  });

  it('binds a fact by its term and names the change that resolved it', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                            status, enqueued_at)
       VALUES ('chg_mention', 'operator', 8, 'служебное намерение', 1, 'sha', '[]', 'phrase', 'done',
               '2026-10-25T12:00:00Z')`,
    ).run();
    const factId = assertFact(db, {
      id: 'fct_shift',
      chapter: 4,
      kind: 'state',
      statement: 'Ночная смена уже идёт.',
      term: 'ночная смена',
    });
    const seeded = seedChapter(db, { chapter: 8, texts: [KEPT] });
    const block = seeded[0];
    if (block === undefined) throw new Error('fixture did not seed a block');

    const applied = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: {
        mode: 'patch',
        edits: [{ blockId: block.id, oldText: 'Нетронутая строчка', newText: 'Началась ночная смена' }],
      },
      cause: { kind: 'change', changeId: 'chg_mention' },
      nowMs: NOW_MS,
    });
    expect(applied).toMatchObject({ ok: true, mentions: 1 });

    expect(db.prepare(`SELECT fact_id, resolved_by_change, kind FROM mentions`).get()).toEqual({
      fact_id: factId,
      resolved_by_change: 'chg_mention',
      kind: 'fact',
    });
    // A fact stated at chapter 4 is true at chapter 8; the mention is bound to that same fact.
    expect(db.prepare(`SELECT chapter FROM mentions`).get()).toEqual({ chapter: 8 });
  });
});
