/**
 * BOOK-222 — a pass's text is a **candidate** until the close publishes it.
 *
 * This file used to prove BOOK-219's invariant by watching a restore revision: the pass published,
 * a gate never answered, the writer put the chapter back. The owner's rule of 2026-10-29 removed
 * that whole story: the engine holds the text on the step, the gates read the candidate, and the
 * close publishes it once. A pass that does not reach `written` leaves nothing to restore — the
 * chapter still reads what the site served, and there is no revision nobody judged.
 *
 * So what is proved here is the *end* of each exit, not the way back:
 *
 *  · Gate B's refusal is the engine's own (`escalated:rights`, the change `void · dropped`);
 *  · a close the engine refuses is the sink, in our own words, with the text never published;
 *  · a rights question that never parses ends in the sink too, with the rule named in the record;
 *  · and the ordinary close announces the landing exactly once: at `done`, never at `land`.
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

describe('a pass closes `done` or leaves the chapter untouched', () => {
  it('drops the candidate when Gate B refuses it, and the sentence is about the text', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const changeId = filed(harness);
      harness.script.push(quotedAnswer(), 'HOLDS', 'HOLDS', 'REFUSED RIGHTS-QUOTE');

      const result = await harness.run({ lanes: ['filing'] });

      // The filing is refused with Gate B's own sentence: this one really is about the text.
      expect(result.status).toBe('parked');
      expect(result.reason).toBe(readerSentences.rightsMissing);
      // Nothing of the candidate reached the reader, and nothing had to be taken back.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness).map((row) => row.kind)).toEqual(['draft']);
      expect(harness.engineCalls).not.toContain('restore');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');
      expect(changeRow(harness, changeId)).toEqual({ status: 'void', outcome: 'dropped' });
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
      expect(stagesOf(harness)).not.toContain('landed');
    } finally {
      await harness.close();
    }
  });

  it('ends in the sink when the close is refused after the gates answered: nothing was published', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const changeId = filed(harness);
      harness.script.push(chapterAnswer('Глава сорок', 'новый'), 'HOLDS', 'HOLDS');
      harness.hooks.beforeCall = (name) => {
        if (name === 'done') throw new EngineRefusalError('VERDICTS_REQUIRED', 'the step has no verdicts', 409);
      };

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('refused');
      // The candidate was never published, so the sentence says that and not «текст стоит».
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(result.reason).toBe(readerSentences.closeNotPublished);
      expect(changeRow(harness, changeId)?.status).toBe('void');
      expect(revisionsOf(harness).map((row) => row.kind)).toEqual(['draft']);
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
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
        // The hook runs before each call: at both `land` and `done` no claim exists yet — since
        // BOOK-222 the text at `land` is a candidate, and the close is what publishes it.
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

  it('puts the filing’s own sentence into the chapter when the revision never validates', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      filed(harness);
      harness.script.push(
        chapterAnswer('Глава сорок', 'новый'),
        'GAP\nblocker · глава 40, «служебный абзац» · повтор вместо прозы · переписать абзац',
        // The revision's answers break the shape, and the ladder is on its own from there.
        'мусор',
        'мусор',
      );

      const result = await harness.run({ lanes: ['filing'] });

      // The pen's sixth is deterministic: the reader's sentence, placed after the first
      // paragraph, and the pass closes on the machine's own verdicts when the gates stay silent.
      expect(result.status).toBe('closed');
      const written = harness.fixture.readChapter(CHAPTER);
      expect(written).toContain('в главе 40 появляется документ о допуске');
      expect(written?.startsWith('Глава сорок\n\n')).toBe(true);
      expect(stagesOf(harness)).toContain('landed');
    } finally {
      await harness.close();
    }
  });

  it('names the rights rule in the record when the rights question never parses', async () => {
    const original = chapterAnswer('Глава сорок', 'исходный');
    const harness = await createHarness({ ...REWRITE, chapters: { [CHAPTER]: original } });
    try {
      const changeId = filed(harness);
      // A flagged scan asks the copyright question; both answers break its shape, and every
      // attempt after that is refused too — the machine's sixth checks the scan itself.
      harness.script.push(quotedAnswer(), 'HOLDS', 'HOLDS', 'мусор', 'мусор');

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('refused');
      // The rights question was never answered, so the close refused: nothing was published, and
      // the sentence says exactly that instead of claiming a refusal nobody made.
      expect(result.reason).toBe(readerSentences.closeNotPublished);
      expect(harness.logs.join('\n')).toContain('GATE_UNPARSED');
      // Nothing was served, and the engine's own refusal names the rule it could not clear.
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness).map((row) => row.kind)).toEqual(['draft']);
      expect(changeRow(harness, changeId)?.status).toBe('void');
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      expect(stagesOf(harness)).not.toContain('landed');
      expect(stagesOf(harness).at(-1)).toBe('refused');
    } finally {
      await harness.close();
    }
  });

  it('ends in the sink when a thrown failure follows the landing', async () => {
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
        // own re-read, and it dies there — after the draft, outside the gate's catch.
        if (reads === 3) throw new Error('the rows could not be read');
      };

      const result = await harness.run({ lanes: ['filing'] });

      expect(result.status).toBe('refused');
      expect(result.reason).toBe(readerSentences.technical);
      expect(harness.fixture.readChapter(CHAPTER)).toBe(original);
      expect(revisionsOf(harness).map((row) => row.kind)).toEqual(['draft']);
      expect(claims(harness).filter((claim) => claim.kind !== 'decision')).toEqual([]);
      expect(claims(harness).filter((claim) => claim.kind === 'decision')).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
