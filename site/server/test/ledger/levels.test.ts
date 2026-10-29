import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { applyPatch } from '../../src/ledger/applier.ts';
import { assertFact } from '../../src/ledger/facts.ts';
import { findFactShaped } from '../../src/ledger/factShaped.ts';
import { paragraphRecord } from '../../src/ledger/paragraph.ts';
import { replayBlock } from '../../src/ledger/replay.ts';
import { SpanMismatchError } from '../../src/ledger/spans.ts';
import { ledgerFixture, NOW_MS, seedChapter, type LedgerFixture } from './helpers.ts';

/**
 * ADR-043's three levels, one test each — and nothing finer:
 *   1. the paragraph record answers for *any* paragraph, with no fact span at all;
 *   2. a fact span is a `mentions` row with a role and a witness (checked through the guard);
 *   3. a change span plus a checkpoint every eighth version replays the text byte-identically.
 */

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

const PROSE = 'Первый тестовый абзац: альфа и бета.';
const OTHER = 'Второй тестовый абзац: гамма и дельта.';

/** The block id a paragraph carries now: an edit moves it, because the id is content-derived. */
function currentId(db: Db, blockUid: string): string {
  const row = db
    .prepare('SELECT block_id FROM block_versions WHERE block_uid = ? ORDER BY ver DESC LIMIT 1')
    .get(blockUid) as { block_id: string };
  return row.block_id;
}

function patch(db: Db, dataDir: string, blockUid: string, oldText: string, newText: string): void {
  const result = applyPatch({
    db,
    dataDir,
    chapter: 8,
    patch: { mode: 'patch', edits: [{ blockId: currentId(db, blockUid), oldText, newText }] },
    cause: { kind: 'operator' },
    nowMs: NOW_MS,
  });
  if (!result.ok) throw new Error(`patch refused: ${result.code}`);
}

describe('level 1 — the paragraph record always answers', () => {
  it('returns a hand, a moment and a history for a paragraph that carries no fact span', () => {
    fixture = ledgerFixture();
    const { db } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [PROSE, OTHER] });
    const block = seeded[0];
    if (block === undefined) throw new Error('fixture did not seed a block');
    // The seed writes no label, so the hand is the word its actor kind means.
    db.prepare(`UPDATE block_versions SET actor_kind = 'writer', actor_label = '' WHERE block_uid = ?`).run(block.uid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mentions').get()).toEqual({ n: 0 });

    const before = paragraphRecord(db, { chapter: 8, blockUid: block.uid });
    expect(before).toMatchObject({ blockUid: block.uid, ver: 1, hand: 'машина', actorKind: 'writer' });
    expect(before?.history).toHaveLength(1);

    patch(db, fixture.dataDir, block.uid, 'альфа', 'омега');
    patch(db, fixture.dataDir, block.uid, 'бета', 'сигма');

    const after = paragraphRecord(db, { chapter: 8, blockUid: block.uid });
    expect(after).toMatchObject({ ver: 3, hand: 'оператор' });
    expect(after?.at).toBe('2026-10-25T12:00:00Z');
    // Newest first, and the paragraph still carries no fact span — level 1 never depends on one.
    expect(after?.history.map((entry) => entry.ver)).toEqual([3, 2, 1]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE kind = 'fact'`).get()).toEqual({ n: 0 });
    expect(paragraphRecord(db, { chapter: 8, blockUid: 'bkd_missing' })).toBeNull();
  });
});

describe('level 3 — a change span and a checkpoint every eighth version', () => {
  it('replays version 12 byte-identically from the checkpoint at version 8', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const tokens = Array.from({ length: 11 }, (_, index) => `т${String(index + 1).padStart(2, '0')}`);
    const seeded = seedChapter(db, { chapter: 8, texts: [`Абзац: ${tokens.join(', ')}.`] });
    const block = seeded[0];
    if (block === undefined) throw new Error('fixture did not seed a block');

    for (const [index, token] of tokens.entries()) {
      patch(db, dataDir, block.uid, token, `Т${String(index + 1).padStart(2, '0')}`);
      void index;
    }

    const live = db.prepare('SELECT id, text FROM blocks WHERE chapter = 8 AND idx = 0').get() as {
      id: string;
      text: string;
    };
    const checkpoints = db
      .prepare(`SELECT ver FROM block_versions WHERE block_uid = ? AND text != '' ORDER BY ver`)
      .all(block.uid) as Array<{ ver: number }>;
    // The seed's version 1 and every eighth version: 1, 8 — 16 would be the next one.
    expect(checkpoints.map((row) => row.ver)).toEqual([1, 8]);

    const replay = replayBlock(db, { blockUid: block.uid, ver: 12 });
    expect(replay?.checkpointVer).toBe(8);
    expect(replay?.text).toBe(live.text);
    expect(live.text).toBe(`Абзац: ${tokens.map((_, index) => `Т${String(index + 1).padStart(2, '0')}`).join(', ')}.`);

    // BOOK-187: each applier revision carries a real snapshot path — the cold-backup copy the
    // history views and the restore read (`chapterAt`, `readRestoreSource`), written in the same
    // transaction. The ledger's boundary is still the checkpoint (D5); the snapshot exists because
    // block order is not stored per version yet (BOOK-182).
    const snapshots = db.prepare('SELECT snapshot FROM revisions WHERE chapter = 8 ORDER BY rev').all() as Array<{
      snapshot: string;
    }>;
    expect(snapshots).toHaveLength(11);
    expect(snapshots.every((row) => row.snapshot !== '')).toBe(true);
    expect(new Set(snapshots.map((row) => row.snapshot)).size).toBe(11);
    for (const row of snapshots) expect(existsSync(join(dataDir, row.snapshot))).toBe(true);

    // The replay checks the text it applies: a tampered span is a refusal, not a plausible text.
    const tampered = db
      .prepare('SELECT spans FROM block_versions WHERE block_uid = ? AND ver = 11')
      .get(block.uid) as { spans: string };
    const spans = JSON.parse(tampered.spans) as Array<{ removed: string }>;
    expect(spans[0]?.removed).toBe('т10');
    if (spans[0] !== undefined) spans[0].removed = 'нет такого';
    db.prepare('UPDATE block_versions SET spans = ? WHERE block_uid = ? AND ver = 11').run(
      JSON.stringify(spans),
      block.uid,
    );
    expect(() => replayBlock(db, { blockUid: block.uid, ver: 12 })).toThrow(SpanMismatchError);
  });
});

describe('replay — an unknown delta is not a stale text', () => {
  it('returns null for a version that records neither a span nor a checkpoint', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: [PROSE, OTHER] });
    const [first, second] = seeded;
    if (first === undefined || second === undefined) throw new Error('fixture did not seed two blocks');

    // The writer lane (`history/blocks.ts::recordBlockRevision`) writes exactly this on a
    // non-checkpoint version of a rewrite: the hash moves, the delta is not recorded yet.
    const next = 'Переписанный абзац: сигма и омега.';
    db.prepare(
      `INSERT INTO block_versions
         (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
          change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
       VALUES (?, 2, 8, 2, 2, ?, ?, ?, 'revised', 1, NULL, NULL, NULL, 'writer', 'машина', NULL, ?,
               '[]', '')`,
    ).run(
      first.uid,
      `ch08#${'0'.repeat(8)}`,
      'deadbeef',
      next.length,
      '2026-10-25T12:00:00Z',
    );
    expect(replayBlock(db, { blockUid: first.uid, ver: 2 })).toBeNull();
    // The checkpoint itself is still a true answer.
    expect(replayBlock(db, { blockUid: first.uid, ver: 1 })).toEqual({ text: PROSE, checkpointVer: 1 });

    // A version that does carry its delta still replays — the rule is about unknown steps only.
    patch(db, dataDir, second.uid, 'гамма', 'сигма');
    expect(replayBlock(db, { blockUid: second.uid, ver: 2 })).toEqual({
      text: OTHER.replace('гамма', 'сигма'),
      checkpointVer: 1,
    });
  });
});

describe('the fact-shaped guard and the published gap (D4, D9, L8)', () => {
  it('warns instead of refusing, and the gap closes when a fact covers the token', () => {
    fixture = ledgerFixture();
    const { db, dataDir } = fixture;
    const seeded = seedChapter(db, { chapter: 8, texts: ['Акт 14.09.2065 подшит в дело.'] });
    const block = seeded[0];
    if (block === undefined) throw new Error('fixture did not seed a block');

    // The recogniser sees the date, and nothing binds it yet.
    expect(findFactShaped('Акт 14.09.2065 подшит в дело.')).toEqual([
      { raw: '14.09.2065', kind: 'date', start: 4, end: 14 },
    ]);

    const first = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: currentId(db, block.uid), oldText: 'подшит', newText: 'подшит крепко' }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(first).toMatchObject({ ok: true, warnings: 1 });
    if (first.ok) expect(first.warnings).toBe(1);
    if (!first.ok) throw new Error('unreachable');
    expect(first.ledgerGap).toBeGreaterThanOrEqual(1);

    const note = db.prepare('SELECT log_note FROM revisions WHERE chapter = 8 AND rev = 2').get() as {
      log_note: string;
    };
    const warning = JSON.parse(note.log_note) as {
      code: string;
      count: number;
      samples: Array<{ blockId: string; raw: string; start: number; end: number }>;
    };
    expect(warning.code).toBe('FACT_SHAPED_UNBOUND');
    expect(warning.count).toBeGreaterThanOrEqual(1);
    expect(warning.samples[0]).toMatchObject({ blockId: expect.any(String), raw: '14.09.2065' });
    expect((db.prepare('SELECT ledger_gap FROM chapters WHERE n = 8').get() as { ledger_gap: number }).ledger_gap).toBe(
      first.ledgerGap,
    );

    // The date's literal mention is not a fact span: it carries no role and does not close the gap.
    expect(db.prepare(`SELECT role, witness FROM mentions WHERE kind = 'date'`).get()).toEqual({
      role: null,
      witness: '14.09.2065',
    });

    assertFact(db, {
      id: 'fct_act',
      chapter: 5,
      kind: 'document',
      statement: 'Акт от 14.09.2065 существует.',
      term: '14.09.2065',
    });
    const second = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: currentId(db, block.uid), oldText: 'крепко', newText: 'ровно' }] },
      cause: { kind: 'operator' },
      nowMs: NOW_MS,
    });
    expect(second).toMatchObject({ ok: true, warnings: 0, ledgerGap: 0 });

    // ADR-043 D3/L3: the fact span carries its role and its witness. The fact was established in
    // chapter 5 and is mentioned in chapter 8, so the mention is a `use` — the chapter does not
    // assert it, it consumes it.
    expect(db.prepare(`SELECT role, witness, edge_path, fact_id FROM mentions WHERE kind = 'fact'`).get()).toEqual({
      role: 'use',
      witness: '14.09.2065',
      edge_path: '[]',
      fact_id: 'fct_act',
    });
    // A mention is live-only: the row was re-bound by the second patch, not accumulated.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE kind = 'fact'`).get()).toEqual({ n: 1 });
  });
});
