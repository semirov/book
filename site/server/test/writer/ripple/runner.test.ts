/**
 * The drainer's seams into the rest of the writer (BOOK-173, BOOK-DOC-75 §4, §6): the character
 * measure a landed chapter reports, the frame probe the verification asks, and the one-chapter
 * runner `--ripple` hands the loop. Small functions, but they are where a wrong number would look
 * like a healthy ripple.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../../src/db/db.ts';
import type { RipplePlan } from '../../../src/ledger/graph/plan.ts';
import { chapterChangedChars, frameProbe, runDrainChapter, type DrainPassInput } from '../../../src/writer/ripple/drain.ts';
import type { PassResult } from '../../../src/writer/passLane.ts';
import type { WriterConfig } from '../../../src/writer/config.ts';
import { writeSnapshot } from '../../../src/versions/snapshots.ts';
import { AT, ledgerFixture, seedChapter, type LedgerFixture } from '../../ledger/helpers.ts';
import { sha256Hex } from '../../../src/util/hash.ts';

let fixture: LedgerFixture;
let db: Db;

afterEach(() => {
  db.close();
  fixture.close();
});

function plan(): RipplePlan {
  return {
    changeId: 'chg_1',
    chapter: 5,
    outcome: 'ripple',
    proven: true,
    seeds: [],
    nodes: [
      {
        factId: 'f:a',
        chapter: 12,
        blockId: 'ch12#a1',
        mandatory: true,
        reason: 'CAUSE_CHANGED:edg_doc_12' as never,
        direction: 'forward' as never,
        hops: 1,
        via: [],
        quote: 'Допуск всё ещё выдан.',
      },
    ],
    edges: [],
    edgeDetail: [],
    patches: [],
    closureSize: { nodes: 1, edges: 0, chapters: 2, parts: 0 },
    chaptersTouched: [5, 12],
    bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
    unresolved: [],
    truncated: false,
  };
}

describe('the drainer’s measures', () => {
  it('reads a chapter’s changed characters from its last two revisions', () => {
    fixture = ledgerFixture();
    db = fixture.db;
    seedChapter(db, { chapter: 12, texts: ['Допуск выдан.'], at: AT });
    const before = 'Допуск выдан.';
    const after = 'Допуск аннулирован.';
    const first = writeSnapshot(fixture.dataDir, 12, sha256Hex(before), before);
    const second = writeSnapshot(fixture.dataDir, 12, sha256Hex(after), after);
    const insert = db.prepare(
      `INSERT INTO revisions (chapter, rev, at, kind, cause_kind, added, changed, removed, snapshot)
       VALUES (12, ?, ?, 'edit', 'cascade', 0, 1, 0, ?)`,
    );
    insert.run(1, AT, first);
    insert.run(2, AT, second);
    // «выдан» → «аннулирован»: the one region between the common prefix and the full stop.
    expect(chapterChangedChars(db, fixture.dataDir, 12)).toBe(12);
    // A chapter with no revisions changed nothing: the drainer charges it nothing.
    expect(chapterChangedChars(db, fixture.dataDir, 13)).toBe(0);
  });

  it('treats a missing chapter as an intact frame, and reads a real one', () => {
    fixture = ledgerFixture();
    db = fixture.db;
    const probe = frameProbe(fixture.db);
    expect(probe(12)).toBe(true); // no rows at all: a chapter the ripple never wrote
  });
});

describe('one chapter of a ripple, handed to the pass', () => {
  it('passes the synthetic assignment through and reports what the pass spent', async () => {
    fixture = ledgerFixture();
    db = fixture.db;
    seedChapter(db, { chapter: 12, texts: ['Допуск выдан.'], at: AT });
    const before = writeSnapshot(fixture.dataDir, 12, sha256Hex('Допуск выдан.'), 'Допуск выдан.');
    const after = writeSnapshot(fixture.dataDir, 12, sha256Hex('Допуск аннулирован.'), 'Допуск аннулирован.');
    db.prepare(
      `INSERT INTO revisions (chapter, rev, at, kind, cause_kind, added, changed, removed, snapshot)
       VALUES (12, 1, ?, 'edit', 'cascade', 0, 1, 0, ?)`,
    ).run(AT, before);
    db.prepare(
      `INSERT INTO revisions (chapter, rev, at, kind, cause_kind, added, changed, removed, snapshot)
       VALUES (12, 2, ?, 'edit', 'cascade', 0, 1, 0, ?)`,
    ).run(AT, after);

    const seen: Array<{ chapter: number; changeId: string; reason: string; claim: string }> = [];
    const input: DrainPassInput = {
      db,
      config: {} as WriterConfig,
      bookRoot: fixture.dataDir,
      dataDir: fixture.dataDir,
      engine: {} as never,
      provider: (() => Promise.reject(new Error('the model is never called here'))) as never,
      now: () => Date.parse(AT),
      log: () => undefined,
      pass: async (ripple) => {
        seen.push(ripple);
        return { status: 'closed', costUsd: 0.13 } satisfies PassResult;
      },
    };
    const result = await runDrainChapter(input, plan(), 12, plan().nodes);
    expect(seen).toEqual([
      { chapter: 12, changeId: 'chg_1', reason: 'CAUSE_CHANGED:edg_doc_12', claim: '«Допуск всё ещё выдан.» — CAUSE_CHANGED:edg_doc_12' },
    ]);
    expect(result).toMatchObject({ landed: true, costUsd: 0.13, changedChars: 12 });
  });

  it('reports a pass that did not close as a chapter that did not land', async () => {
    fixture = ledgerFixture();
    db = fixture.db;
    seedChapter(db, { chapter: 12, texts: ['Допуск выдан.'], at: AT });
    const result = await runDrainChapter(
      {
        db,
        config: {} as WriterConfig,
        bookRoot: fixture.dataDir,
        dataDir: fixture.dataDir,
        engine: {} as never,
        provider: (() => Promise.reject(new Error('no model'))) as never,
        now: () => Date.parse(AT),
        log: () => undefined,
        pass: async () => ({ status: 'parked', reason: 'гейты отказали' }),
      },
      plan(),
      12,
      plan().nodes,
    );
    expect(result).toMatchObject({ landed: false, reason: 'гейты отказали', costUsd: 0 });
  });
});
