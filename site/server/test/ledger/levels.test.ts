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
    expect(before).toMatchObject({ blockUid: block.uid, ver: 1, hand: 'печатник', actorKind: 'writer' });
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

    // No chapter snapshot per applier revision: the checkpoint is the boundary.
    const snapshots = db.prepare('SELECT snapshot FROM revisions WHERE chapter = 8').all() as Array<{
      snapshot: string;
    }>;
    expect(snapshots).toHaveLength(11);
    expect(snapshots.every((row) => row.snapshot === '')).toBe(true);

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

    // ADR-043 D3: the fact span carries its role and its witness; stage 2 turns 'use' on.
    expect(db.prepare(`SELECT role, witness, edge_path, fact_id FROM mentions WHERE kind = 'fact'`).get()).toEqual({
      role: 'assert',
      witness: '14.09.2065',
      edge_path: '[]',
      fact_id: 'fct_act',
    });
    // A mention is live-only: the row was re-bound by the second patch, not accumulated.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mentions WHERE kind = 'fact'`).get()).toEqual({ n: 1 });
  });
});
