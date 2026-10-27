import { describe, expect, it } from 'vitest';

import { computeImpact, readImpact, rebuildImpacts } from '../../src/history/impact.ts';
import { listRevisions } from '../../src/db/repo/revisions.ts';
import { listEventRows } from '../../src/history/events.ts';
import { createEngineFixture, runStubStep } from '../engine/helpers.ts';

describe('T-impact — what a change did, materialized at close (§6F.5)', () => {
  it('records the impact of a change that lands without a ripple', () => {
    const fixture = createEngineFixture();
    try {
      runStubStep(fixture, { title: 'Тестовая глава', blocks: ['Тестовый абзац.', 'Это служебный текст.'] });
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать второе упоминание абзаца',
      });
      const origin = runStubStep(fixture, {
        title: 'Тестовая глава',
        blocks: ['Тестовый абзац.'],
      });
      expect(origin?.assignment.pass).toBe('change');
      expect(origin?.result.cascadeId).toBeNull();

      const row = fixture.db.prepare('SELECT * FROM change_impact WHERE change_id = ?').get(change.id) as
        | Record<string, unknown>
        | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(String(row?.chapters_touched))).toEqual([1]);
      expect(JSON.parse(String(row?.chapters_rewritten))).toEqual([1]);
      expect(Number(row?.blocks_changed)).toBeGreaterThan(0);
      expect(Number(row?.from_hseq)).toBeGreaterThan(0);
      expect(Number(row?.to_hseq)).toBeGreaterThanOrEqual(Number(row?.from_hseq));
      expect(Number(row?.tokens)).toBeGreaterThan(0);

      const impact = readImpact(fixture.db, change.id);
      expect(impact?.changeId).toBe(change.id);
      expect(impact?.depth).toEqual({ down: 0, up: 0 });
      // BOOK-23: steps recorded tokens but no price, so the money is absent — a sum of
      // placeholder zeros is not a measurement and must not print as «0,00 ₽».
      expect(impact?.tokens).toBeGreaterThan(0);
      expect(impact?.costRub).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('records a cascade: the chapters it touched and how far it went', () => {
    const fixture = createEngineFixture();
    try {
      runStubStep(fixture, { title: 'Тестовая глава', blocks: ['Тестовый абзац.', 'Это служебный текст.'] });
      runStubStep(fixture, { title: 'Вторая глава', blocks: ['Ещё один служебный абзац для проверки, он не является текстом книги и не содержит литературных образов.'] });
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать второе упоминание абзаца',
      });
      const origin = runStubStep(fixture, {
        title: 'Тестовая глава',
        blocks: ['Тестовый абзац.'],
        seams: [{ boundary: 2, reason: 'соседняя глава начинается с того же абзаца' }],
      });
      expect(origin?.result.cascadeId).toBeTruthy();

      const repair = runStubStep(fixture, {
        title: 'Вторая глава',
        blocks: ['Ещё один служебный абзац для проверки, он не является текстом книги и не содержит литературных образов.', 'Добавленный абзац номер два.'],
      });
      expect(repair?.assignment.pass).toBe('cascade');
      expect(repair?.assignment.chapter).toBe(2);

      // The ripple reaches the first sheet; that step closes the cascade and the change.
      const front = runStubStep(fixture, {
        title: 'Без названия',
        blocks: [fixture.readFrontBlocks()],
        seams: [],
      });
      expect(front?.assignment.pass).toBe('front');

      const row = fixture.db.prepare('SELECT * FROM change_impact WHERE change_id = ?').get(change.id) as
        | Record<string, unknown>
        | undefined;
      expect(row).toBeDefined();
      const touched = JSON.parse(String(row?.chapters_touched)) as number[];
      expect(touched).toContain(1);
      expect(touched).toContain(2);
      expect(Number(row?.depth_up)).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(String(row?.seams))).toEqual(
        expect.arrayContaining([expect.objectContaining({ boundary: 2 })]),
      );
    } finally {
      fixture.close();
    }
  });

  it('is a projection: a rebuild reproduces the same numbers', () => {
    const fixture = createEngineFixture();
    try {
      runStubStep(fixture, { title: 'Тестовая глава', blocks: ['Тестовый абзац.', 'Это служебный текст.'] });
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'сократить' });
      runStubStep(fixture, { title: 'Тестовая глава', blocks: ['Тестовый абзац.'] });
      // Finish the change so a close-time projection exists, then wipe and rebuild it.
      fixture.db.prepare(`UPDATE changes SET finished_at = '2026-10-25T10:00:00Z', status = 'done' WHERE id = ?`).run(
        change.id,
      );
      const first = computeImpact(fixture.db, change.id, Date.parse('2026-10-25T10:05:00Z'));
      expect(first).not.toBeNull();
      fixture.db.prepare('DELETE FROM change_impact').run();
      expect(rebuildImpacts(fixture.db, Date.parse('2026-10-25T10:05:00Z'))).toBe(1);
      const rebuilt = readImpact(fixture.db, change.id);
      expect(rebuilt).toEqual(first);
      // The projection is stable across a second rebuild too.
      expect(rebuildImpacts(fixture.db, Date.parse('2026-10-25T10:05:00Z'))).toBe(1);
      expect(readImpact(fixture.db, change.id)).toEqual(first);
    } finally {
      fixture.close();
    }
  });

  it('answers «which change touched chapter 9» from the events index, not from prose', () => {
    const fixture = createEngineFixture();
    try {
      runStubStep(fixture, {
        title: 'Девятая',
        blocks: ['Тестовый абзац.', 'Это служебный текст.'],
      }, 'fwd');
      const events = listEventRows(fixture.db, { chapter: 1 });
      expect(events.some((row) => row.kind === 'chapter.created')).toBe(true);
      const revisions = listRevisions(fixture.db, 1) as Array<{ hseq: number | null; cause_kind: string; attributed: number }>;
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.hseq).not.toBeNull();
      expect(revisions[0]?.cause_kind).toBe('draft');
      expect(revisions[0]?.attributed).toBe(1);
    } finally {
      fixture.close();
    }
  });
});
