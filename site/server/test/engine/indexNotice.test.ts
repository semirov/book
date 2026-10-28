import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reconcile } from '../../src/ingest/reconcile.ts';
import { readIndex } from '../../src/index/store.ts';
import { publishIndexNotices } from '../../src/engine/indexNotice.ts';
import * as store from '../../src/engine/store.ts';
import { readEventRow, toHistoryEvent } from '../../src/history/events.ts';
import { chapterText, createEngineFixture, runStubStep } from './helpers.ts';

type Fixture = ReturnType<typeof createEngineFixture>;
type EventRowLite = { hseq: number; payload: string };

function statementRows(db: Fixture['db']): EventRowLite[] {
  return db
    .prepare(`SELECT hseq, payload FROM events WHERE kind = 'document.status' ORDER BY hseq`)
    .all() as EventRowLite[];
}

const ISSUED = 'Приказ № 4 выдан утром.';
const ANNULLED = 'Приказ № 4 отозван. Инженер Ковалёв молчал.';

/** Publish the projection and its rev-1 snapshots — the «before» side of a real diff. */
function publishSources(fixture: Fixture): void {
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir, now: new Date(fixture.clock.now()) });
}

function changeOf(fixture: Fixture, id: string): store.ChangeRow {
  const row = store.getChange(fixture.db, id);
  if (row === undefined) throw new Error('the change vanished');
  return row;
}

function summaryOf(fixture: Fixture, hseq: number): string {
  const row = readEventRow(fixture.db, hseq);
  if (row === undefined) throw new Error('the statement row is missing');
  return toHistoryEvent(row).summary;
}

describe('a closed change speaks once about a moved document (BOOK-18 §3)', () => {
  it('emits one statement naming the paper’s surface and the chapter, with the change attached', () => {
    const fixture = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [ISSUED]) } });
    try {
      publishSources(fixture);
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'изменить статус документа' });
      const run = runStubStep(fixture, { title: 'Глава 2', blocks: [ANNULLED] });
      expect(run?.result.changeStatus).toBe('done');

      const rows = statementRows(fixture.db);
      expect(rows).toHaveLength(1);
      const row = readEventRow(fixture.db, rows[0]?.hseq ?? 0);
      if (row === undefined) throw new Error('the statement row is missing');
      const event = toHistoryEvent(row);
      expect(event).toMatchObject({ kind: 'document.status', chapter: null, changeId: change.id });
      // The surface the text uses, not the normalised key.
      expect(event.summary).toBe('статус документа Приказ № 4 изменён в главе 2');
      expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({
        document: 'приказ № 4',
        surface: 'Приказ № 4',
        chapters: [2],
      });
      // The statement is the paper and the chapters — no entity, no role, no finding text.
      expect(JSON.stringify(event)).not.toContain('Ковалёв');
      expect(JSON.stringify(event)).not.toMatch(/editor|consultant|blocker|замечание/u);
    } finally {
      fixture.close();
    }
  });

  it('emits nothing when a change closes without touching a document status', () => {
    const fixture = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [ISSUED]) } });
    try {
      publishSources(fixture);
      fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'ничего не менять' });
      const run = runStubStep(fixture, { title: 'Глава 2', blocks: [ISSUED] });
      expect(run?.result.outcome).toBe('holds');
      expect(statementRows(fixture.db)).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it('emits nothing when the pre-image is unavailable: a lost snapshot is not «everything appeared»', () => {
    // (a) The chapter was never projected: rev_before is 0, so there is nothing to compare.
    const never = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [ISSUED]) } });
    try {
      never.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'изменить статус' });
      runStubStep(never, { title: 'Глава 2', blocks: [ANNULLED] });
      expect(statementRows(never.db)).toHaveLength(0);
    } finally {
      never.close();
    }

    // (b) The projection says rev 1 but the snapshot file is gone: same silence.
    const lostSnapshot = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [ISSUED]) } });
    try {
      publishSources(lostSnapshot);
      const row = lostSnapshot.db
        .prepare('SELECT snapshot FROM revisions WHERE chapter = 2 AND rev = 1')
        .get() as { snapshot: string } | undefined;
      if (row === undefined) throw new Error('the rev-1 snapshot is missing from the fixture');
      rmSync(join(lostSnapshot.dataDir, row.snapshot));
      lostSnapshot.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'изменить статус' });
      runStubStep(lostSnapshot, { title: 'Глава 2', blocks: [ANNULLED] });
      expect(statementRows(lostSnapshot.db)).toHaveLength(0);
    } finally {
      lostSnapshot.close();
    }
  });

  it('names one document and three chapters in a single statement for a three-chapter change', () => {
    const fixture = createEngineFixture({
      chapters: {
        12: chapterText('Глава 12', [ISSUED]),
        19: chapterText('Глава 19', [ISSUED]),
        40: chapterText('Глава 40', [ISSUED]),
      },
    });
    try {
      publishSources(fixture);
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 12, intent: 'три главы' });
      const at = new Date(fixture.clock.now()).toISOString();
      for (const chapter of [12, 19, 40]) {
        const stepId = `stp_book18_${chapter}`;
        store.insertStep(fixture.db, {
          stepId,
          cascadeId: null,
          seq: chapter,
          wave: 1,
          lane: 'forward',
          pass: 'cascade',
          chapter,
          boundary: String(chapter),
          seamsIn: '[]',
          revBefore: 1,
          at,
        });
        store.updateStep(fixture.db, stepId, { outcome: 'rewritten', closed_at: at });
        fixture.db
          .prepare(
            `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session,
               expected_rev, acquired_at, heartbeat_at, expires_at, released_at)
             VALUES (?, ?, ?, 'forward', ?, 0, 'cascade', 'w', 1, ?, ?, ?, ?)`,
          )
          .run(`lea_book18_${chapter}`, stepId, change.id, chapter, at, at, at, at);
        fixture.writeChapterBlocks(chapter, `Глава ${chapter}`, ['Приказ № 4 отозван утром.']);
      }
      publishIndexNotices(fixture.deps, changeOf(fixture, change.id), fixture.clock.now());

      const rows = statementRows(fixture.db);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({
        document: 'приказ № 4',
        surface: 'Приказ № 4',
        chapters: [12, 19, 40],
      });
      expect(summaryOf(fixture, rows[0]?.hseq ?? 0)).toBe('статус документа Приказ № 4 изменён в главах 12, 19, 40');
      // The close does not rebuild the artifact; the next editor dispatch does (BOOK-18 §2).
      expect(readIndex(fixture.dataDir)).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('is idempotent: a repeated close for the same change adds no second statement', () => {
    const fixture = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [ISSUED]) } });
    try {
      publishSources(fixture);
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'изменить статус' });
      runStubStep(fixture, { title: 'Глава 2', blocks: [ANNULLED] });
      publishIndexNotices(fixture.deps, changeOf(fixture, change.id), fixture.clock.now());
      expect(statementRows(fixture.db)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });
});
