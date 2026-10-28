/**
 * Sentence identity through `applyPatch` (ADR-044 §2.2/§2.3 — the ADR's proof plan T2–T6, BOOK-182).
 *
 * Every case is a **real patch** through the applier. The tests never call the transform directly,
 * because what they pin is the whole write path: the paragraph is renamed, its sentences keep
 * their ids, the provenance rows name the edit that moved them, and the mentions of the new text
 * land on the sentence that carries them.
 *
 * The prose is synthetic — six sentences of one shape, so a patch can be written against a word
 * and the outcome counted in rows.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { insertComment, resolveAnchor, type CommentRow } from '../../src/comments/repo.ts';
import type { Db } from '../../src/db/db.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { applyPatch } from '../../src/ledger/applier.ts';
import { assertFact } from '../../src/ledger/facts.ts';
import { sliceCp } from '../../src/ledger/spans.ts';
import { resolveQuoteSentence } from '../../src/sentences/anchor.ts';
import { sentenceHash } from '../../src/sentences/hash.ts';
import { insertImportedSentences, listLiveSentences, type SentenceRow } from '../../src/sentences/store.ts';
import { AT, ledgerFixture, NOW_MS, seedChange, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';

const CH = 12;
const S = [
  'Первое предложение стоит здесь.',
  'Второе предложение стоит здесь.',
  'Третье предложение стоит здесь.',
  'Четвёртое предложение стоит здесь.',
  'Пятое предложение стоит здесь.',
  'Шестое предложение стоит здесь.',
];
const TEXT = S.join(' ');

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

type Seed = { db: Db; dataDir: string; blockId: string; ids: string[] };

/** One chapter, one block, its text segmented once — and the ids it was published with. */
function seed(text: string = TEXT): Seed {
  fixture = ledgerFixture();
  const { db, dataDir } = fixture;
  const block = seedChapter(db, { chapter: CH, texts: [text] })[0];
  if (block === undefined) throw new Error('fixture did not seed the block');
  const rows = insertImportedSentences(db, { blockId: block.id, text, at: AT }).rows;
  return { db, dataDir, blockId: block.id, ids: rows.map((row) => row.id) };
}

/** The chapter's only block id after a patch: it is content-derived, so it moves with the text. */
function blockOf(db: Db): { id: string; text: string } {
  return db.prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx').get(CH) as {
    id: string;
    text: string;
  };
}

function live(db: Db): SentenceRow[] {
  return listLiveSentences(db, blockOf(db).id);
}

/** The live sentences as they read — cut out of the paragraph, in display order. */
function reads(db: Db): string[] {
  const text = blockOf(db).text;
  return live(db).map((row) => sliceCp(text, row.start, row.end));
}

function touches(db: Db): Array<{ sentence_id: string; kind: string; change_id: string | null; at: string }> {
  return db
    .prepare('SELECT sentence_id, kind, change_id, at FROM sentence_touches ORDER BY id')
    .all() as Array<{ sentence_id: string; kind: string; change_id: string | null; at: string }>;
}

function sentenceReading(rows: ReadonlyArray<SentenceRow>, text: string): SentenceRow {
  const found = rows.find((row) => row.text_hash === sentenceHash(text));
  if (found === undefined) throw new Error(`no sentence reads «${text}»`);
  return found;
}

/** One edit through the real applier, asserted to land. */
function edit(input: {
  db: Db;
  dataDir: string;
  blockId: string;
  oldText: string;
  newText: string;
  changeId?: string;
  nowMs?: number;
}): void {
  const applied = applyPatch({
    db: input.db,
    dataDir: input.dataDir,
    chapter: CH,
    patch: { mode: 'patch', edits: [{ blockId: input.blockId, oldText: input.oldText, newText: input.newText }] },
    cause: input.changeId === undefined ? { kind: 'operator' } : { kind: 'change', changeId: input.changeId },
    nowMs: input.nowMs ?? NOW_MS,
  });
  expect(applied).toMatchObject({ ok: true });
}

describe('applyPatch — sentence identity (ADR-044 §2.3)', () => {
  it('keeps every id through a word fix inside sentence 3, and touches exactly that sentence', () => {
    const { db, dataDir, blockId, ids } = seed();
    seedChange(db, { id: 'chg_word', chapter: CH });
    const before = live(db);

    edit({ db, dataDir, blockId, oldText: 'Третье', newText: 'Трижды', changeId: 'chg_word' });

    const after = live(db);
    expect(after.map((row) => row.id)).toEqual(ids);
    // Only sentence 3's content attribute moved; the other five still hash what they hashed.
    expect(after[2]?.text_hash).not.toBe(before[2]?.text_hash);
    expect(after.filter((_row, index) => index !== 2).map((row) => row.text_hash)).toEqual(
      before.filter((_row, index) => index !== 2).map((row) => row.text_hash),
    );
    expect(reads(db)[2]).toBe('Трижды предложение стоит здесь.');
    // The block id is content-derived, so the rows follow the paragraph to its new id.
    expect(blockOf(db).id).not.toBe(blockId);
    expect(after.every((row) => row.block_id === blockOf(db).id)).toBe(true);
    // One touch, of one kind, with the change that caused it and the revision's own moment.
    expect(touches(db)).toEqual([{ sentence_id: ids[2], kind: 'text', change_id: 'chg_word', at: AT }]);
  });

  it('borns the inserted sentence before sentence 3 and re-numbers the rest without touching them', () => {
    const { db, dataDir, blockId, ids } = seed();

    edit({ db, dataDir, blockId, oldText: 'Третье', newText: 'Новое предложение стоит здесь. Третье' });

    const after = live(db);
    expect(after).toHaveLength(7);
    expect(reads(db)).toEqual([
      S[0],
      S[1],
      'Новое предложение стоит здесь.',
      S[2],
      S[3],
      S[4],
      S[5],
    ]);
    const born = after[2];
    if (born === undefined) throw new Error('the insertion did not land at position 3');
    expect(ids).not.toContain(born.id);
    // The six old ids survive in order, one position later where the insertion pushed them.
    expect(after.filter((row) => row.id !== born.id).map((row) => row.id)).toEqual(ids);
    expect(after.map((row) => row.idx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // The inserted sentence is nobody's split: it is born, and only it is touched.
    expect(born.split_from).toBeNull();
    expect(touches(db)).toEqual([{ sentence_id: born.id, kind: 'born', change_id: null, at: AT }]);
  });

  it('splits sentence 2 on an inserted terminator: the left keeps the id, the right is born from it', () => {
    const { db, dataDir, blockId, ids } = seed();

    edit({
      db,
      dataDir,
      blockId,
      oldText: 'Второе предложение стоит здесь.',
      newText: 'Второе предложение. Стоит здесь.',
    });

    const after = live(db);
    const left = sentenceReading(after, 'Второе предложение.');
    const right = sentenceReading(after, 'Стоит здесь.');
    expect(left.id).toBe(ids[1]);
    expect(right.id).not.toBe(ids[1]);
    expect(right.split_from).toBe(ids[1]);
    expect(left.split_from).toBeNull();
    expect(reads(db).slice(0, 3)).toEqual(['Первое предложение стоит здесь.', 'Второе предложение.', 'Стоит здесь.']);
    expect(touches(db)).toEqual([
      { sentence_id: ids[1] ?? '', kind: 'split', change_id: null, at: AT },
      { sentence_id: right.id, kind: 'born', change_id: null, at: AT },
    ]);
  });

  it('merges sentences 2 and 3 on a removed terminator: the left survives, the right closes into it', () => {
    const { db, dataDir, blockId, ids } = seed();

    edit({ db, dataDir, blockId, oldText: 'здесь. Третье', newText: 'здесь Третье' });

    const after = live(db);
    expect(after).toHaveLength(5);
    const merged = sentenceReading(after, 'Второе предложение стоит здесь Третье предложение стоит здесь.');
    expect(merged.id).toBe(ids[1]);
    // The right half is history: the row stays, closed, and names the sentence that absorbed it.
    expect(db.prepare('SELECT erased_at, merged_into FROM sentences WHERE id = ?').get(ids[2])).toEqual({
      erased_at: AT,
      merged_into: ids[1],
    });
    expect(touches(db)).toEqual([
      { sentence_id: ids[1] ?? '', kind: 'text', change_id: null, at: AT },
      { sentence_id: ids[2] ?? '', kind: 'merge', change_id: null, at: AT },
    ]);
  });

  it('erases a deleted sentence and gives the same id back when its words return', () => {
    const { db, dataDir, blockId, ids } = seed();

    edit({ db, dataDir, blockId, oldText: 'Четвёртое предложение стоит здесь. ', newText: '' });

    expect(live(db).map((row) => row.id)).toEqual([ids[0], ids[1], ids[2], ids[4], ids[5]]);
    // The row stays: an erased sentence is history, not a deletion.
    expect(db.prepare('SELECT erased_at, merged_into FROM sentences WHERE id = ?').get(ids[3])).toEqual({
      erased_at: AT,
      merged_into: null,
    });
    expect(touches(db)).toEqual([{ sentence_id: ids[3] ?? '', kind: 'erase', change_id: null, at: AT }]);

    // A later patch puts the same sentence back before «Пятое»: the id comes back with the words.
    edit({
      db,
      dataDir,
      blockId: blockOf(db).id,
      oldText: 'Пятое',
      newText: 'Четвёртое предложение стоит здесь. Пятое',
      nowMs: NOW_MS + 60_000,
    });

    expect(live(db).map((row) => row.id)).toEqual(ids);
    expect(reads(db)[3]).toBe('Четвёртое предложение стоит здесь.');
    expect(db.prepare('SELECT erased_at FROM sentences WHERE id = ?').get(ids[3])).toEqual({ erased_at: null });
    expect(touches(db).slice(1)).toEqual([
      { sentence_id: ids[3] ?? '', kind: 'moved', change_id: null, at: '2026-10-25T12:01:00Z' },
    ]);
  });

  it('gives a mention and its literal the sentence that carries them', () => {
    const text = 'Здесь лежит служебный документ. Дата 14.09.2065 стоит здесь.';
    const { db, dataDir, blockId } = seed(text);
    assertFact(db, {
      id: 'fct_document',
      chapter: CH,
      kind: 'document',
      statement: 'Служебный документ существует.',
      term: 'служебный документ',
      at: AT,
    });

    edit({ db, dataDir, blockId, oldText: 'лежит', newText: 'стоит' });

    const rows = live(db);
    const carrier = sentenceReading(rows, 'Здесь стоит служебный документ.');
    const carrierOfDate = sentenceReading(rows, 'Дата 14.09.2065 стоит здесь.');
    expect(db.prepare('SELECT kind, sentence_id FROM mentions ORDER BY id').all()).toEqual([
      { kind: 'fact', sentence_id: carrier.id },
      { kind: 'date', sentence_id: carrierOfDate.id },
    ]);
    expect(db.prepare('SELECT literal, sentence_id FROM literals').all()).toEqual([
      { literal: '2065-09-14', sentence_id: carrierOfDate.id },
    ]);
  });

  it('leaves a carrier null when the term runs across a sentence boundary', () => {
    const text = 'Здесь лежит служебный документ. Дата 14.09.2065 стоит здесь.';
    const { db, dataDir, blockId } = seed(text);
    assertFact(db, {
      id: 'fct_straddle',
      chapter: CH,
      kind: 'decision',
      statement: 'Служебная формулировка через границу предложений.',
      term: 'документ. Дата',
      at: AT,
    });

    edit({ db, dataDir, blockId, oldText: 'лежит', newText: 'стоит' });

    // The words are in the block and the mention exists — but no one sentence holds them, so the
    // carrier is null rather than the sentence the span happens to start in.
    expect(db.prepare('SELECT kind, sentence_id FROM mentions WHERE fact_id = ?').all('fct_straddle')).toEqual([
      { kind: 'fact', sentence_id: null },
    ]);
  });

  it('seeds a block that has no sentence rows yet, and never re-attaches a merged one', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    // A paragraph that predates v25: text and a row in `blocks`, no sentence row at all.
    const block = seedChapter(db, { chapter: CH, texts: [S.join(' ')] })[0];
    if (block === undefined) throw new Error('fixture did not seed the block');

    edit({ db, dataDir, blockId: block.id, oldText: 'Третье', newText: 'Трижды' });

    expect(live(db)).toHaveLength(S.length);
    expect(reads(db)[2]).toBe('Трижды предложение стоит здесь.');
    expect(touches(db).map((row) => row.kind)).toEqual(Array<string>(S.length).fill('born'));

    // A merge closes the right half into the left; those words are alive inside the survivor, so
    // pasting them back later is a new sentence — not the closed id rising again.
    const after = live(db);
    const [left, right] = [after[1], after[2]];
    if (left === undefined || right === undefined) throw new Error('fixture needs two sentences');
    edit({ db, dataDir, blockId: blockOf(db).id, oldText: 'здесь. Трижды', newText: 'здесь Трижды' });
    const merged = db.prepare('SELECT id, erased_at, merged_into FROM sentences WHERE id = ?').get(right.id) as {
      id: string;
      erased_at: string | null;
      merged_into: string | null;
    };
    expect(merged.merged_into).toBe(left.id);
    expect(merged.erased_at).toBe(AT);

    edit({
      db,
      dataDir,
      blockId: blockOf(db).id,
      oldText: 'Четвёртое',
      newText: 'Трижды предложение стоит здесь. Четвёртое',
      nowMs: NOW_MS + 60_000,
    });
    const pasted = sentenceReading(live(db), 'Трижды предложение стоит здесь.');
    expect(pasted.id).not.toBe(right.id);
    expect(pasted.split_from).toBeNull();
  });

  it('writes nothing when the patch repeats the paragraph', () => {
    const { db, dataDir, blockId, ids } = seed();

    edit({ db, dataDir, blockId, oldText: S[0] ?? '', newText: S[0] ?? '' });

    expect(live(db).map((row) => row.id)).toEqual(ids);
    expect(live(db).map((row) => row.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(touches(db)).toEqual([]);
  });

  it('keeps the block anchor when the stored sentence id belongs to another live block', () => {
    fixture = ledgerFixture();
    const { db } = fixture;
    const blocks = seedChapter(db, { chapter: CH, texts: [S.join(' '), 'Отдельный служебный абзац здесь.'] });
    const [first, second] = blocks;
    if (first === undefined || second === undefined) throw new Error('fixture needs two blocks');
    insertImportedSentences(db, { blockId: first.id, text: first.text, at: AT });
    const elsewhere = insertImportedSentences(db, { blockId: second.id, text: second.text, at: AT }).rows[0];
    if (elsewhere === undefined) throw new Error('the second block has no sentence');

    const reader = upsertIdentity(db, { yandexSub: 'test-reader', displayName: 'Читатель', at: AT });
    insertComment(db, {
      id: 'cmt_other_block',
      identityId: reader.id,
      chapter: CH,
      blockId: first.id,
      blockIndex: 0,
      baseRev: 1,
      quote: S[0] ?? '',
      prefix: null,
      suffix: null,
      // A row that names a sentence of the paragraph next door is not this filing's anchor.
      sentenceId: elsewhere.id,
      selStart: 0,
      selEnd: 5,
      author: 'Читатель',
      body: 'Служебное замечание.',
      proposedText: null,
      interventionKind: null,
      bodySha: 'sha',
      flags: [],
      ipHash: 'ip',
      status: 'new',
      guard: null,
      reason: null,
      createdAt: AT,
      idemKey: null,
    });
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get('cmt_other_block') as CommentRow;

    const anchor = resolveAnchor(db, row);
    expect(anchor.sentenceId).toBeUndefined();
    expect(anchor.blockId).toBe(first.id);
    expect(anchor.resolved).toBe(true);
  });

  it('survives a patch that swaps two paragraphs, ids and all', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const X = 'Альфа стоит здесь. Бета стоит здесь.';
    const Y = 'Гамма стоит здесь. Дельта стоит здесь.';
    const [a, b] = seedChapter(db, { chapter: CH, texts: [X, Y] });
    if (a === undefined || b === undefined) throw new Error('fixture needs two blocks');
    const idsOfA = insertImportedSentences(db, { blockId: a.id, text: X, at: AT }).rows.map((row) => row.id);
    const idsOfB = insertImportedSentences(db, { blockId: b.id, text: Y, at: AT }).rows.map((row) => row.id);

    // A block id is content-derived, so this patch hands each paragraph the other's id. The
    // sentence rows have to be read before either moves, and parked before either is written —
    // otherwise one block's finals land in the space the other still occupies.
    const applied = applyPatch({
      db,
      dataDir,
      chapter: CH,
      patch: {
        mode: 'patch',
        edits: [
          { blockId: a.id, oldText: X, newText: Y },
          { blockId: b.id, oldText: Y, newText: X },
        ],
      },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(applied).toMatchObject({ ok: true });

    const textOf = (id: string): string =>
      (db.prepare('SELECT text FROM blocks WHERE id = ?').get(id) as { text: string }).text;
    // The ids travelled with the paragraphs: A's sentences stand where B's stood.
    expect(listLiveSentences(db, b.id).map((row) => row.id)).toEqual(idsOfA);
    expect(listLiveSentences(db, a.id).map((row) => row.id)).toEqual(idsOfB);
    expect(listLiveSentences(db, b.id).map((row) => sliceCp(textOf(b.id), row.start, row.end))).toEqual([
      'Гамма стоит здесь.',
      'Дельта стоит здесь.',
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sentences WHERE erased_at IS NULL').get()).toEqual({ n: 4 });
  });

  it('keeps a filing on its sentence when a neighbour is inserted before it', () => {
    const { db, dataDir, blockId } = seed();
    const reader = upsertIdentity(db, { yandexSub: 'test-reader', displayName: 'Читатель', at: AT });
    const quote = S[3] ?? '';
    const placement = resolveQuoteSentence(db, { blockId, quote });
    expect(placement).not.toBeNull();
    insertComment(db, {
      id: 'cmt_identity',
      identityId: reader.id,
      chapter: CH,
      blockId,
      blockIndex: 0,
      baseRev: 1,
      quote,
      prefix: null,
      suffix: null,
      sentenceId: placement?.sentenceId ?? null,
      selStart: placement?.selStart ?? null,
      selEnd: placement?.selEnd ?? null,
      author: 'Читатель',
      body: 'Служебное замечание к четвёртому предложению.',
      proposedText: null,
      interventionKind: null,
      bodySha: 'sha',
      flags: [],
      ipHash: 'ip',
      status: 'new',
      guard: null,
      reason: null,
      createdAt: AT,
      idemKey: null,
    });
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get('cmt_identity') as CommentRow;

    // The neighbour arrives before the sentence the reader filed against.
    edit({ db, dataDir, blockId, oldText: 'Четвёртое', newText: 'Новое предложение стоит здесь. Четвёртое' });

    const anchor = resolveAnchor(db, row);
    expect(anchor.sentenceId).toBe(placement?.sentenceId);
    expect(anchor.resolved).toBe(true);
    // The stored offsets still cut the same characters out of the same sentence.
    const sentence = live(db).find((candidate) => candidate.id === anchor.sentenceId);
    if (sentence === undefined) throw new Error('the anchored sentence is gone');
    const from = sentence.start + (anchor.selStart ?? 0);
    const to = sentence.start + (anchor.selEnd ?? 0);
    expect(sliceCp(blockOf(db).text, from, to)).toBe(quote);
  });
});
