/**
 * BOOK-219, the invariant: **a pass either closes with `done`, or the chapter goes back to the
 * revision the pass found.** There is no third exit.
 *
 * `passEstimated.test.ts` proves it for a gate that never answered. This file proves the rest of
 * the exits, in particular the worst one: the rights gate refuses the text, the engine closes the
 * step as `escalated:rights`, and before this fix the refused revision stayed published while the
 * reader was told «правка не принята». Also covered: an answer that never parses, a revision that
 * never validates, a thrown failure after the landing, a close the engine refuses after the gates
 * answered — and the ordinary close, which must announce the landing exactly once: at the close,
 * never at `land`.
 */

import { describe, expect, it } from 'vitest';

import { upsertSubscription } from '../../src/push/repo.ts';
import { listStages } from '../../src/stages/repo.ts';
import { EngineRefusalError } from '../../src/writer/client.ts';
import { readerSentences } from '../../src/writer/reasons.ts';
import { accept, seed } from '../engine/premiseHelpers.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

/**
 * The seam these tests prove is the close and the way back, so they write a whole chapter:
 * `WRITER_MODE_DEFAULT=rewrite` is the owner's switch, and the patch default has its own
 * files (`patchPass.test.ts`, `noOpPass.test.ts`).
 */
const REWRITE = { env: { WRITER_MODE_DEFAULT: 'rewrite' } };

const CHAPTER = 40;
const AT = '2026-10-25T09:00:00Z';

/** The reader a filing belongs to, with a device — the only way a push claim is taken. */
function readerWithDevice(harness: Harness): void {
  harness.fixture.db
    .prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_viewer', 'yandex-viewer', 'Аня', ?, ?)`,
    )
    .run(AT, AT);
  upsertSubscription(
    harness.fixture.db,
    'idn_viewer',
    { endpoint: 'https://push.example.com/anya', p256dh: 'a'.repeat(64), auth: 'b'.repeat(20) },
    Date.parse(AT),
  );
}

/** One accepted change on a written chapter: the lane's own job, with a real filing behind it. */
function filed(harness: Harness): string {
  readerWithDevice(harness);
  const commentId = seed(harness.fixture.db, { chapter: CHAPTER });
  return accept(harness.fixture.db, commentId, 'в главе 40 появляется документ о допуске').changeId;
}

/** A chapter the rights scan flags: a long quoted run in «…» reads as unquoted third-party text. */
function quotedAnswer(): string {
  const quote = `«${'чужой текст без источника повторяется в этой главе снова и снова, '.repeat(12).trim()}»`;
  return `${chapterAnswer('Глава сорок', 'правка')}\n\n${quote}\n`;
}

function stagesOf(harness: Harness): string[] {
  return listStages(harness.fixture.db, CHAPTER).map((stage) => stage.stage);
}

function revisionsOf(harness: Harness): Array<{ rev: number; kind: string }> {
  return harness.fixture.db
    .prepare('SELECT rev, cause_kind AS kind FROM revisions WHERE chapter = ? ORDER BY rev DESC')
    .all(CHAPTER) as Array<{ rev: number; kind: string }>;
}

function changeRow(harness: Harness, id: string): Record<string, unknown> | undefined {
  return harness.fixture.db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

function claims(harness: Harness): Array<{ chapter: number; kind: string }> {
  return harness.fixture.db.prepare('SELECT chapter, kind FROM push_log').all() as Array<{
    chapter: number;
    kind: string;
  }>;
}

describe('a pass closes `done` or puts the chapter back', () => {
  it('takes the refused text back when the rights gate refuses it', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const changeId = filed(harness);
      harness.script.push(quotedAnswer(), 'HOLDS', 'HOLDS', 'REFUSED RIGHTS-QUOTE');

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('parked');
      // The refused revision is not live: the chapter reads what the pass found, as a restore.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness).map((row) => row.kind)).toEqual(['restore', 'change', 'draft']);
      // The step was stopped by the engine (`escalated:rights` is the step's word), and the change
      // is refused: `void · dropped` with the gate's sentence, never `escalated`.
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');
      expect(changeRow(harness, changeId)).toEqual({ status: 'void', outcome: 'dropped' });
      expect(changeRow(harness, changeId)?.outcome).not.toBe('applied');
      // Gate B's refusal **is** the engine's refusal: the step closes and the text is put back
      // before the writer asks, so the writer's own `putBack` finds nothing of its own to move
      // (`откат не нужен`) and its copy falls to «новый текст стоит без проверки прав».
      // The fact the reader can check is the engine's: the chapter reads the pre-pass text. The
      // sentence is `writer/**`'s and is the seam this change leaves open (see the report).
      expect(result.reason).toBe(readerSentences.rightsUnverified);
      expect(harness.logs.join('\n')).toContain('откат не нужен');
      // Nothing was announced about a landing, and no stage claims one.
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      // The refusal is a decision: the reader who filed hears it once (BOOK-189).
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
      expect(stagesOf(harness)).not.toContain('landed');
      expect(stagesOf(harness)).toContain('verdict');
    } finally {
      await harness.close();
    }
  });

  it('puts the chapter back when the close is refused after the gates answered', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const changeId = filed(harness);
      harness.script.push(chapterAnswer('Глава сорок', 'новый'), 'HOLDS', 'HOLDS');
      // Every verdict is in and the engine still refuses the close: there is no `done` to keep.
      harness.hooks.beforeCall = (name) => {
        if (name === 'done') throw new EngineRefusalError('VERDICTS_REQUIRED', 'the step has no verdicts', 409);
      };

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('parked');
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness)[0]?.kind).toBe('restore');
      expect(result.reason).toBe(readerSentences.closeReverted);
      expect(changeRow(harness, changeId)?.status).toBe('void');
      // A close that failed leaves no «глава написана» line and no push claim behind.
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      // The refusal is a decision: the reader who filed hears it once (BOOK-189).
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
      expect(stagesOf(harness)).not.toContain('landed');
      expect(harness.logs.join('\n')).toContain('VERDICTS_REQUIRED');
    } finally {
      await harness.close();
    }
  });

  it('announces the landing once, at the close — never at `land`', async () => {
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: chapterAnswer('Глава сорок', 'исходный') } });
    try {
      filed(harness);
      harness.script.push(chapterAnswer('Глава сорок', 'новый'), 'HOLDS', 'HOLDS');
      const atLand: number[] = [];
      const atDone: number[] = [];
      harness.hooks.beforeCall = (name) => {
        // The hook runs before each call: at `done` the rows still hold nothing about a landing.
        if (name === 'land') atLand.push(claims(harness).length);
        if (name === 'done') atDone.push(claims(harness).length);
      };

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('closed');
      expect(atLand).toEqual([0]);
      expect(atDone).toEqual([0]);
      // One claim, one outbox row, both written by the close.
      expect(claims(harness)).toEqual([{ chapter: CHAPTER, kind: 'landed' }]);
      const outbox = harness.fixture.db.prepare('SELECT title FROM push_outbox').all() as Array<{ title: string }>;
      expect(outbox).toEqual([{ title: `глава ${String(CHAPTER)} написана` }]);
      // The stage comes after the close, once, and the pass closed `done`.
      expect(stagesOf(harness).filter((stage) => stage === 'landed')).toHaveLength(1);
      expect(stagesOf(harness).at(-1)).toBe('landed');
    } finally {
      await harness.close();
    }
  });

  it('puts the chapter back when the gate’s revision never validates', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      filed(harness);
      harness.script.push(
        chapterAnswer('Глава сорок', 'новый'),
        'GAP\nblocker · глава 40, «служебный абзац» · повтор вместо прозы · переписать абзац',
        // Both revision answers break the shape: the pass has landed and cannot revise.
        'мусор',
        'мусор',
      );

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('parked');
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness)[0]?.kind).toBe('restore');
      expect(result.reason).toBe(readerSentences.reverted);
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      // The refusal is a decision: the reader who filed hears it once (BOOK-189).
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
      expect(stagesOf(harness)).not.toContain('landed');
    } finally {
      await harness.close();
    }
  });

  it('puts the chapter back when a gate answer never parses', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      filed(harness);
      // A flagged scan asks the copyright question; both answers break its shape.
      harness.script.push(quotedAnswer(), 'HOLDS', 'HOLDS', 'мусор', 'мусор');

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('parked');
      expect(harness.logs.join('\n')).toContain('GATE_UNPARSED');
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness)[0]?.kind).toBe('restore');
      expect(result.reason).toBe(readerSentences.reverted);
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      // The refusal is a decision: the reader who filed hears it once (BOOK-189).
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
      expect(stagesOf(harness)).not.toContain('landed');
    } finally {
      await harness.close();
    }
  });

  it('puts the chapter back when a thrown failure follows the landing', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      filed(harness);
      harness.script.push(
        chapterAnswer('Глава сорок', 'новый'),
        'GAP\nblocker · глава 40, «служебный абзац» · повтор вместо прозы · переписать абзац',
      );
      let reads = 0;
      harness.hooks.beforeCall = (name) => {
        if (name !== 'text') return;
        reads += 1;
        // Reads 1 and 2 are the prompt and the editor's dispatch; the third is the revision's
        // own re-read, and it dies there — after the draft landed, outside the gate's catch. The
        // way back reads the chapter once more, so only that one call is broken.
        if (reads === 3) throw new Error('the rows could not be read');
      };

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('parked');
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness)[0]?.kind).toBe('restore');
      expect(result.reason).toBe(readerSentences.reverted);
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      // The refusal is a decision: the reader who filed hears it once (BOOK-189).
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
