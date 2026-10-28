import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { applyPatch, revertRevision } from '../../src/ledger/applier.ts';
import { AT, ledgerCounts, ledgerFixture, NOW_MS, seedChapter, type LedgerFixture } from './helpers.ts';

// Synthetic fixture prose, never book text.
const A = 'Первый тестовый абзац: альфа, бета и гамма.';
const B = 'Второй тестовый абзац: дельта, эпсилон и дзета.';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function blockRow(db: Db, id: string): { id: string; text: string; hash: string } {
  return db.prepare('SELECT id, text, hash FROM blocks WHERE id = ?').get(id) as {
    id: string;
    text: string;
    hash: string;
  };
}

describe('applyPatch — the round trip', () => {
  it('applies one edit and reverts it byte-identically, with a span that carries its inverse', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const [, second] = seedChapter(db, { chapter: 8, texts: [A, B] });
    if (second === undefined) throw new Error('fixture did not seed the second block');
    const before = blockRow(db, second.id);

    const applied = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: second.id, oldText: 'дзета', newText: 'омега' }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(applied).toMatchObject({ ok: true, chapter: 8, rev: 2, spans: 1, blocksChanged: 1 });

    const version = db.prepare('SELECT * FROM block_versions WHERE chapter = 8 AND ver = 2').get() as
      | { spans: string; block_id: string; op: string }
      | undefined;
    expect(version).toBeDefined();
    const spans = JSON.parse(version?.spans ?? '[]') as Array<{
      insert: string;
      removed: string;
      invert: { insert: string; removed: string } | null;
      cause: { kind: string };
    }>;
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      insert: 'омега',
      removed: 'дзета',
      cause: { kind: 'legacy' },
      invert: { insert: 'дзета', removed: 'омега' },
    });

    const reverted = revertRevision({ db, dataDir, chapter: 8, rev: applied.ok ? applied.rev : 0, nowMs: NOW_MS });
    expect(reverted.ok).toBe(true);

    const after = blockRow(db, before.id);
    expect(after.text).toBe(before.text);
    expect(after.hash).toBe(before.hash);
    expect(after.id).toBe(before.id);
    // The revert is a revision of its own: a third version, and a span that undoes the second.
    expect(db.prepare('SELECT COUNT(*) AS n FROM block_versions WHERE chapter = 8').get()).toEqual({ n: 4 });
  });

  it('records the change that caused an edit on the span, the version and the revision', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const [, second] = seedChapter(db, { chapter: 8, texts: [A, B] });
    const changeId = 'chg_ledger';
    db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                            status, enqueued_at)
       VALUES (?, 'operator', 8, 'служебное намерение', 1, 'sha', '[]', 'phrase', 'done', ?)`,
    ).run(changeId, AT);

    const applied = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: second?.id ?? '', oldText: 'дзета', newText: 'омега' }] },
      cause: { kind: 'change', changeId },
      nowMs: NOW_MS,
    });
    expect(applied.ok).toBe(true);
    const span = JSON.parse(
      (db.prepare('SELECT spans FROM block_versions WHERE chapter = 8 AND ver = 2').get() as { spans: string }).spans,
    ) as Array<{ cause: { kind: string; id: string | null } }>;
    expect(span[0]?.cause).toEqual({ kind: 'change', id: changeId });
    expect(db.prepare('SELECT change_id FROM revisions WHERE chapter = 8 AND rev = 2').get()).toEqual({
      change_id: changeId,
    });
  });
});

describe('applyPatch — refusals leave nothing behind', () => {
  it('refuses a patch whose second edit does not match, and writes nothing', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [A, B] });
    const [first, second] = seeded;
    if (first === undefined || second === undefined) throw new Error('fixture did not seed two blocks');
    const before = ledgerCounts(db, 8);

    const result = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: {
        mode: 'patch',
        edits: [
          { blockId: first.id, oldText: 'альфа', newText: 'альфа-2' },
          { blockId: second.id, oldText: 'которого нет в тексте', newText: 'что-то' },
        ],
      },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ ok: false, code: 'OLD_TEXT_NOT_FOUND', blockId: second.id });
    expect(ledgerCounts(db, 8)).toEqual(before);
    expect(blockRow(db, first.id).text).toBe(A);
  });

  it('refuses an ambiguous oldText, a missing block, a missing chapter and an empty result', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: ['Альфа. Альфа.', B] });
    const [first, second] = seeded;
    if (first === undefined || second === undefined) throw new Error('fixture did not seed two blocks');
    const cause = { kind: 'operator' as const };

    expect(
      applyPatch({
        db,
        dataDir,
        chapter: 8,
        patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'Альфа', newText: 'Бета' }] },
        cause,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: false, code: 'OLD_TEXT_AMBIGUOUS' });
    expect(
      applyPatch({
        db,
        dataDir,
        chapter: 8,
        patch: { mode: 'patch', edits: [{ blockId: 'ch08#00000000', oldText: 'Альфа', newText: 'Бета' }] },
        cause,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: false, code: 'BLOCK_NOT_FOUND' });
    expect(
      applyPatch({
        db,
        dataDir,
        chapter: 9,
        patch: { mode: 'patch', edits: [{ blockId: second.id, oldText: 'дельта', newText: 'омега' }] },
        cause,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: false, code: 'CHAPTER_NOT_FOUND' });
    expect(
      applyPatch({
        db,
        dataDir,
        chapter: 8,
        patch: { mode: 'patch', edits: [{ blockId: second.id, oldText: B, newText: '  ' }] },
        cause,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: false, code: 'EMPTY_BLOCK' });
    // A shape the contract forbids: no edits at all.
    expect(
      applyPatch({ db, dataDir, chapter: 8, patch: { mode: 'patch', edits: [] }, cause, nowMs: NOW_MS }),
    ).toMatchObject({ ok: false, code: 'PATCH_INVALID' });
  });

  it('refuses an edit that would give two paragraphs one identity', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [A, B] });
    const [first, second] = seeded;
    if (first === undefined || second === undefined) throw new Error('fixture did not seed two blocks');
    const before = ledgerCounts(db, 8);

    // Making the first paragraph byte-identical to the second would land on its id, and the
    // ledger cannot renumber the paragraph that is already published.
    const result = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: A, newText: B }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, code: 'PATCH_INVALID' });
    expect(ledgerCounts(db, 8)).toEqual(before);
  });

  it('refuses a chapter whose stored hash no longer matches its text', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [A, B] });
    const [first] = seeded;
    if (first === undefined) throw new Error('fixture did not seed a block');
    db.prepare('UPDATE blocks SET hash = ? WHERE id = ?').run('deadbeef', first.id);

    expect(
      applyPatch({
        db,
        dataDir,
        chapter: 8,
        patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'альфа', newText: 'омега' }] },
        cause: { kind: 'operator' },
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ ok: false, code: 'HASH_MISMATCH' });
  });
});

describe('applyPatch — the frozen frame (F029)', () => {
  it('refuses an edit that touches the canon sentence and accepts one later in the chapter', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const opening = `${FRAME_FIRST_SENTENCE} Первый тестовый абзац: альфа, бета и гамма.`;
    const seeded = seedChapter(db, { chapter: 1, texts: [opening, B] });
    const [first] = seeded;
    if (first === undefined) throw new Error('fixture did not seed the opening block');
    const before = ledgerCounts(db, 1);

    const touched = applyPatch({
      db,
      dataDir,
      chapter: 1,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'пустую комнату', newText: 'тёмную комнату' }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(touched).toMatchObject({ ok: false, code: 'FRAME_CHANGED' });
    expect(ledgerCounts(db, 1)).toEqual(before);

    const later = applyPatch({
      db,
      dataDir,
      chapter: 1,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'гамма', newText: 'омега' }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(later.ok).toBe(true);
    expect(
      (db.prepare('SELECT text FROM blocks WHERE chapter = 1 AND idx = 0').get() as { text: string }).text.startsWith(
        FRAME_FIRST_SENTENCE,
      ),
    ).toBe(true);
  });
});
