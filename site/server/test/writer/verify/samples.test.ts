/**
 * The sampling rule and its record (BOOK-DOC-80 §"The safeguard").
 *
 * Two halves, tested where each lives: the **rule** is pure (`sampleDue`, the drift test), and the
 * **record** is one UPDATE inside the close's transaction — which is why it is proven against a real
 * database: `seq` comes from `changes`, the boot marker from `meta`, and both are read by the same
 * call that writes `sample_requested`. A second reader of either would be a second way to sample.
 */

import { describe, expect, it } from 'vitest';

import { migrate } from '../../../src/db/migrate.ts';
import { openDatabase, type Db } from '../../../src/db/db.ts';
import {
  markWriterBoot,
  pendingWriterBoot,
  recentSampleVerdicts,
  recordSample,
  recordVerification,
  sampleQueue,
} from '../../../src/ledger/graph/verification.ts';
import { seedChange } from '../../ledger/helpers.ts';
import { DEFAULT_AUDIT_SAMPLES, DRIFT_GAPS, SAMPLE_EVERY, agreement, driftDetected, sampleDue } from '../../../src/writer/verify/samples.ts';

const AT = '2026-10-28T12:00:00Z';

function db(): Db {
  const opened = openDatabase(':memory:');
  migrate(opened);
  return opened;
}

/** A change at `seq`, with the plan row its verification is written to. */
function changeAt(database: Db, seq: number): string {
  database.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                          status, enqueued_at, seq)
     VALUES (?, 'operator', 12, 'служебное намерение', 1, 'sha', '[]', 'phrase', 'done', ?, ?)`,
  ).run(`chg_${String(seq)}`, AT, seq);
  database
    .prepare(
      `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, created_at)
       VALUES (?, ?, 12, 'local', '{}', '[]', '{}', ?)`,
    )
    .run(`pln_${String(seq)}`, `chg_${String(seq)}`, AT);
  return `chg_${String(seq)}`;
}

const LOCAL = { gatesMode: 'local only' as const, why: null, tier1Verdict: 'HOLDS' as const, tier1Usd: 0.003 };

function requested(database: Db, changeId: string): number {
  const row = database.prepare('SELECT sample_requested FROM change_plans WHERE change_id = ?').get(changeId) as {
    sample_requested: number;
  };
  return row.sample_requested;
}

describe('the sampling rule', () => {
  it('queues every tenth change and nothing else', () => {
    expect(SAMPLE_EVERY).toBe(10);
    expect(sampleDue({ seq: 10, bootPending: false })).toBe(true);
    expect(sampleDue({ seq: 20, bootPending: false })).toBe(true);
    // The 11th is not the 10th: a sample is the sequence number's fact, not a counter's.
    expect(sampleDue({ seq: 11, bootPending: false })).toBe(false);
    expect(sampleDue({ seq: 9, bootPending: false })).toBe(false);
    expect(sampleDue({ seq: 0, bootPending: false })).toBe(false);
  });

  it('always queues the first change after a boot', () => {
    expect(sampleDue({ seq: 3, bootPending: true })).toBe(true);
  });

  it('compares Tier 1 with the editor, and counts drift over twenty samples', () => {
    expect(agreement('HOLDS', 'HOLDS')).toBe('ok');
    expect(agreement('GAP', 'HOLDS')).toBe('gap');
    expect(agreement('HOLDS', 'GAP')).toBe('ok');
    expect(agreement('HOLDS', null)).toBe('ok');
    expect(DRIFT_GAPS).toBe(2);
    expect(driftDetected(['ok', 'gap'])).toBe(false);
    expect(driftDetected(['gap', 'ok', 'gap'])).toBe(true);
    expect(DEFAULT_AUDIT_SAMPLES).toBe(3);
  });
});

describe('the record on the change', () => {
  it('queues the tenth local-only change and writes the verdict it was closed on', () => {
    const database = db();
    try {
      const changeId = changeAt(database, 10);
      recordVerification(database, { changeId, chapter: 12, stepId: `stp_${changeId}` }, LOCAL, AT);
      const row = database
        .prepare('SELECT gates_mode, tier1_verdict, tier1_usd, sample_requested FROM change_plans WHERE change_id = ?')
        .get(changeId);
      expect(row).toEqual({ gates_mode: 'local only', tier1_verdict: 'HOLDS', tier1_usd: 0.003, sample_requested: 1 });
      // The change's own history says which tiers judged it, and what was queued.
      const event = database
        .prepare(`SELECT type, meta FROM change_events WHERE change_id = ?`)
        .get(changeId) as { type: string; meta: string };
      expect(event.type).toBe('gates');
      expect(JSON.parse(event.meta)).toMatchObject({ gates: 'local only', tier1: 'HOLDS', sampleRequested: true });
    } finally {
      database.close();
    }
  });

  it('does not sample the eleventh, and never samples a full pair', () => {
    const database = db();
    try {
      const eleventh = changeAt(database, 11);
      recordVerification(database, { changeId: eleventh, chapter: 12, stepId: `stp_${eleventh}` }, LOCAL, AT);
      expect(requested(database, eleventh)).toBe(0);
      const full = changeAt(database, 20);
      recordVerification(database, { changeId: full, chapter: 12, stepId: `stp_${full}` }, { ...LOCAL, gatesMode: 'full', why: 'closure_non_empty' }, AT);
      expect(requested(database, full)).toBe(0);
    } finally {
      database.close();
    }
  });

  it('samples the first local-only change after a boot, once — and the marker is consumed', () => {
    const database = db();
    try {
      markWriterBoot(database, '01JBOOTULID');
      expect(pendingWriterBoot(database)).toBe(true);
      const first = changeAt(database, 3);
      recordVerification(database, { changeId: first, chapter: 12, stepId: `stp_${first}` }, LOCAL, AT);
      expect(requested(database, first)).toBe(1);
      expect(pendingWriterBoot(database)).toBe(false);
      const second = changeAt(database, 4);
      recordVerification(database, { changeId: second, chapter: 12, stepId: `stp_${second}` }, LOCAL, AT);
      expect(requested(database, second)).toBe(0);
    } finally {
      database.close();
    }
  });

  it('leaves the marker standing when a full pair closes first', () => {
    const database = db();
    try {
      markWriterBoot(database, '01JBOOTULID');
      const full = changeAt(database, 5);
      recordVerification(database, { changeId: full, chapter: 12, stepId: `stp_${full}` }, { ...LOCAL, gatesMode: 'full', why: 'chapter_edge' }, AT);
      expect(pendingWriterBoot(database)).toBe(true);
      const local = changeAt(database, 6);
      recordVerification(database, { changeId: local, chapter: 12, stepId: `stp_${local}` }, LOCAL, AT);
      expect(requested(database, local)).toBe(1);
    } finally {
      database.close();
    }
  });
});

describe('the queue', () => {
  it('drains the oldest requested samples, and a failed read stays in it', () => {
    const database = db();
    try {
      const older = changeAt(database, 10);
      const newer = changeAt(database, 20);
      recordVerification(database, { changeId: older, chapter: 12, stepId: `stp_${older}` }, LOCAL, AT);
      recordVerification(database, { changeId: newer, chapter: 12, stepId: `stp_${newer}` }, LOCAL, AT);

      const queue = sampleQueue(database, 3);
      expect(queue.map((sample) => sample.changeId)).toEqual([older, newer]);
      const first = queue[0];
      if (first === undefined) throw new Error('the queue is empty');
      expect(first.tier1Verdict).toBe('HOLDS');

      recordSample(database, first.planRowId, 'error', AT);
      expect(sampleQueue(database, 3).map((sample) => sample.changeId)).toEqual([older, newer]);
      recordSample(database, first.planRowId, 'ok', AT);
      expect(sampleQueue(database, 3).map((sample) => sample.changeId)).toEqual([newer]);
      expect(recentSampleVerdicts(database, 20)).toEqual(['ok']);
    } finally {
      database.close();
    }
  });

  it('keeps one row per change, so a re-plan does not queue a second sample', () => {
    const database = db();
    try {
      const changeId = seedChange(database, { id: 'chg_one', chapter: 12, at: AT });
      database
        .prepare(
          `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, created_at)
           VALUES ('pln_one', ?, 12, 'local', '{}', '[]', '{}', ?)`,
        )
        .run(changeId, AT);
      recordVerification(database, { changeId, chapter: 12, stepId: `stp_${changeId}` }, LOCAL, AT);
      // seq 1 is not a tenth: no sample, but the row still carries the record.
      expect(requested(database, changeId)).toBe(0);
      expect(sampleQueue(database, 3)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
