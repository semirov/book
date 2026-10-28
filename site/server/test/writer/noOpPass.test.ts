/**
 * The silent no-op, made visible (BOOK-173 §5).
 *
 * A rewrite can return the chapter **byte for byte** — measured on ch03: 69 s, 10 010 output
 * tokens, nothing applied. Until this cut that pass closed the step `holds` and the change
 * `applied`: the reader's own record said «внесена» about a chapter nobody moved, and the queue
 * counted a success. The engine now compares the landed file with the pre-image `start` captured
 * and closes the change `no-op`; this file proves the whole path, including the money that was
 * spent and could not be recovered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyChapterFile } from '../../src/ingest/applyChapter.ts';
import { decisionOutcome } from '../../src/engineState/changes.ts';
import { listStages } from '../../src/stages/repo.ts';
import { createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 12;
const TITLE = 'Глава двенадцатая';

function para(marker: string, chars = 700): string {
  const head = `${marker} `;
  const text = 'Служебный текст для проверки объёма страницы, он не является текстом книги. ';
  return `${head}${text.repeat(Math.ceil(chars / text.length) + 1)}`.slice(0, chars);
}

function chapterFile(harness: Harness): string {
  return join(harness.bookRoot, 'manuscript', `ch${String(CHAPTER).padStart(2, '0')}.md`);
}

/** A written chapter, ingested, and a **chapter-scope** filing on it: the pass must rewrite. */
async function written(): Promise<{ harness: Harness; changeId: string }> {
  const text = `${TITLE}\n\n${[para('Первый абзац.'), para('Гуси шли по льду.'), para('Третий абзац.'), para('Четвёртый абзац.')].join('\n\n')}\n`;
  const harness = await createHarness({ chapters: { [CHAPTER]: text } });
  harness.ingest(CHAPTER);
  const filed = harness.fixture.engine.enqueue({
    kind: 'operator',
    chapter: CHAPTER,
    intent: 'в главе 12 меняется порядок сцен',
    scopeHint: 'chapter',
  });
  return { harness, changeId: filed.id };
}

function changeRow(harness: Harness, changeId: string): { id: string; status: string; outcome: string | null } {
  const row = harness.fixture.db.prepare('SELECT id, status, outcome FROM changes WHERE id = ?').get(changeId) as
    | { id: string; status: string; outcome: string | null }
    | undefined;
  if (row === undefined) throw new Error(`no change ${changeId}`);
  return row;
}

function count(harness: Harness, sql: string): number {
  return (harness.fixture.db.prepare(sql).get() as { n: number }).n;
}

describe('a rewrite that changes nothing is a no-op, not a landing', () => {
  it('closes the change `no-op`, says the line, keeps no revision and still records the money', async () => {
    const { harness, changeId } = await written();
    try {
      // The provider hands back the chapter exactly as it stands — the measured case of BOOK-173,
      // verbatim: 69 s of model time and not one byte of the book moved.
      const preImage = readFileSync(chapterFile(harness), 'utf8');
      harness.script.push(preImage, 'HOLDS', 'HOLDS');

      const result = await harness.run({ lanes: ['fwd'] });
      if (result.status !== 'closed') throw new Error(`parked: ${harness.logs.join(' | ')}`);
      expect(result.status).toBe('closed');

      const change = changeRow(harness, changeId);
      expect(change.status).toBe('done');
      expect(change.outcome).toBe('no-op');
      // The reader's own record says the same word, never «внесена» (MyDecisionOutcome).
      expect(decisionOutcome({ status: 'done', outcome: 'no-op' })).toBe('no-op');

      // The step did not move the text: `holds` is the existing word for exactly that.
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('holds');
      // One factual line, and no `applied` anywhere in the record.
      expect(harness.logs.join('\n')).toContain('перепись не изменила ни одного байта');
      expect(harness.logs.join('\n')).not.toContain('applied');
      const decided = harness.fixture.db
        .prepare(`SELECT payload FROM events WHERE kind = 'change.decided' ORDER BY hseq DESC LIMIT 1`)
        .get() as { payload: string } | undefined;
      expect(decided?.payload).toContain('"no-op"');
      expect(decided?.payload).not.toContain('"applied"');

      // No revision: the file was already the file, so the site published nothing.
      expect(count(harness, 'SELECT COUNT(*) AS n FROM revisions')).toBe(1);
      // The money was spent and is in the ledger — a no-op is not a refund.
      const spend = harness.fixture.db
        .prepare('SELECT usd, pass_id FROM pass_spend WHERE pass_id = ?')
        .get(result.stepId ?? '') as { usd: number; pass_id: string } | undefined;
      expect(spend?.pass_id).toBe(result.stepId);
      expect(spend?.usd).toBeGreaterThan(0);
      // Nothing to walk: a byte-identical landing has no edited block and therefore no plan, so
      // the mode of this pass is on its close (`step.closed.payload.mode`), which is where a
      // change with no plan keeps it.
      expect(count(harness, 'SELECT COUNT(*) AS n FROM change_plans')).toBe(0);
      const closed = harness.fixture.db
        .prepare(`SELECT payload FROM events WHERE kind = 'step.closed' AND step_id = ?`)
        .get(result.stepId ?? '') as { payload: string } | undefined;
      expect(closed?.payload).toContain('"mode":"rewrite"');
      // The landed stage prints what landed — the pre-image's own numbers, not a false delta.
      expect(listStages(harness.fixture.db, CHAPTER).at(-1)?.stage).toBe('landed');
    } finally {
      await harness.close();
    }
  });

  it('is idempotent: a second identical publish adds neither a revision nor a second plan row', async () => {
    const { harness } = await written();
    try {
      const raw = readFileSync(chapterFile(harness), 'utf8');
      harness.script.push(raw, 'HOLDS', 'HOLDS');
      const result = await harness.run({ lanes: ['fwd'] });
      if (result.status !== 'closed') throw new Error(`parked: ${harness.logs.join(' | ')}`);
      expect(result.status).toBe('closed');
      const revisions = count(harness, 'SELECT COUNT(*) AS n FROM revisions');

      // The same bytes observed again (the watcher, a retried land) publish nothing.
      const again = applyChapterFile({
        db: harness.fixture.db,
        dataDir: harness.dataDir,
        n: CHAPTER,
        raw,
        mtimeMs: harness.fixture.clock.now(),
        nowMs: harness.fixture.clock.now(),
      });
      expect(again.status).toBe('unchanged');
      expect(count(harness, 'SELECT COUNT(*) AS n FROM revisions')).toBe(revisions);
      expect(count(harness, 'SELECT COUNT(*) AS n FROM change_plans')).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
