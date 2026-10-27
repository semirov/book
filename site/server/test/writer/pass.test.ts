/**
 * One pass, end to end (`docs/writer-lane.md` §1, §5): a real engine, a real control API and a
 * scripted provider. What is asserted is the whole trail — the file, the step, the change, the
 * premise, the stages in order, the money, the transcript — because each of those is a fact a
 * reader or an operator can see and a missing one is a silent lie.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BudgetDto } from '@book/shared';

import { formatUsd } from '../../src/budget.ts';
import { main } from '../../src/writer/main.ts';
import { costUsd } from '../../src/writer/pipeline.ts';
import { listStages } from '../../src/stages/repo.ts';
import { toIso } from '../../src/util/time.ts';
import { chapterAnswer, createHarness, stepRow } from './harness.ts';

const CHAPTER = 65;

/** The engine's money answer as a test states it: no ledger, just the numbers the guard reads. */
function budgetOf(input: {
  daySpent: number;
  bookSpent?: number;
  dayCap?: number;
  bookCap?: number;
  state?: BudgetDto['state'];
  line?: string;
  tokens?: number;
}): BudgetDto {
  const dayCap = input.dayCap ?? 10;
  const bookCap = input.bookCap ?? 1_000;
  const bookSpent = input.bookSpent ?? input.daySpent;
  return {
    state: input.state ?? 'ok',
    line: input.line ?? '',
    day: {
      spentUsd: input.daySpent,
      capUsd: dayCap,
      ratio: input.daySpent / dayCap,
      day: '2026-10-27',
      resumesAt: '2026-10-28T00:00:00.000Z',
    },
    book: { spentUsd: bookSpent, capUsd: bookCap, ratio: bookSpent / bookCap },
    tokens: { today: input.tokens ?? 0 },
  };
}

const PAUSE_LINE = 'пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC';
const STOP_LINE = `остановлено · потолок книги ${formatUsd(1_000)} $`;

describe('runPass — one pass, end to end', () => {
  it('writes the chapter, closes the step, settles the premise and tells the stages in order', async () => {
    const harness = await createHarness();
    try {
      const changeId = harness.premised(CHAPTER, 'в главе 65 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');

      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
      expect(result.stepId).toBeDefined();

      // 1. The file holds the answer, and the engine reads a whole chapter.
      const chainPath = join(harness.bookRoot, 'manuscript', 'ch65.md');
      expect(existsSync(chainPath)).toBe(true);
      const written = readFileSync(chainPath, 'utf8');
      expect(written.startsWith('Глава шестьдесят пять\n\n')).toBe(true);
      expect(written).toContain('служебный абзац для проверки объёма страницы');
      expect(existsSync(`${chainPath}.tmp`)).toBe(false);

      // 2. The step is closed with the model and the summed tokens (writer + both gates).
      const step = stepRow(harness.fixture, result.stepId ?? '');
      expect(step).toMatchObject({ outcome: 'rewritten', model: harness.config.apiModel, cycle: 0 });
      expect(step?.tokens_in).toBe(3_000);
      expect(step?.tokens_out).toBe(600);

      // 3. The premise settles as applied — the change is not a cascade.
      expect(
        harness.fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(changeId),
      ).toEqual({ status: 'done', outcome: 'applied', reason: 'вошло в первую редакцию главы 65' });

      // 4. The stages, in the order the work happened; one producer per stage.
      const stages = listStages(harness.fixture.db, CHAPTER);
      expect(stages.map((stage) => stage.stage)).toEqual([
        'queued',
        'read',
        'drafting',
        'drafting',
        'verdict',
        'verdict',
        'landed',
      ]);
      expect(stages.map((stage) => stage.stageSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      for (const stage of stages) {
        expect(stage.chapter).toBe(CHAPTER);
        expect(stage.passId).toBe(result.stepId);
        expect(stage.summary.length).toBeGreaterThan(0);
        expect(stage.summary.length).toBeLessThanOrEqual(200);
      }
      expect(stages[0]?.summary).toContain('замысел: в главе 65 появляется документ о допуске');
      expect(stages[1]?.summary).toContain('промпт собран');
      expect(stages[4]?.summary).toBe('редактор: HOLDS · замечаний нет');
      expect(stages[5]?.summary).toBe('консультант: HOLDS · замечаний нет');

      // 5. `landed` names the chapter's blocks and charges the pass once.
      const landed = stages.at(-1);
      expect(landed?.stage).toBe('landed');
      expect(landed?.span).toHaveLength(1);
      expect(landed?.span?.[0]?.blockId).toBeNull();
      expect(landed?.span?.[0]?.before).toBe('');
      expect(landed?.span?.[0]?.after.startsWith('служебный абзац')).toBe(true);
      expect(landed?.tokens).toEqual({ in: 3_000, out: 600 });
      expect(landed?.costUsd).toBe(costUsd(harness.config.pipeline.pricing, { in: 3_000, out: 600, cachedIn: 0 }));
      expect(landed?.costUsd).toBeGreaterThan(0);

      // 6. The transcript holds the requests and the answers, and never the key.
      const transcript = join(harness.dataDir, 'writer', 'transcripts', `${result.stepId ?? ''}.json`);
      expect(existsSync(transcript)).toBe(true);
      const saved = readFileSync(transcript, 'utf8');
      expect(saved).not.toContain('sk-writer-harness');
      const parsed = JSON.parse(saved) as {
        calls: Array<{ kind: string; system: string; user: string; answer: string }>;
        sections: number;
        promptSha256: string;
        estimate: { usd: number; calls: number; tokensIn: number; assumptions: Record<string, number> };
        result: { status: string };
      };
      expect(parsed.calls.map((call) => call.kind)).toEqual(['draft', 'gate:editor', 'gate:consultant']);
      expect(parsed.calls[0]?.answer).toContain('Глава шестьдесят пять');
      expect(parsed.sections).toBeGreaterThan(3);
      expect(parsed.promptSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(parsed.result.status).toBe('closed');

      // 6b. The estimate that let the pass run is in the transcript, and one line says it aloud.
      expect(parsed.estimate.usd).toBeGreaterThan(0);
      expect(parsed.estimate.calls).toBe(6);
      expect(parsed.estimate.assumptions.charsPerToken).toBe(2.3);
      expect(harness.logs.some((line) => line.includes('оценка прохода $'))).toBe(true);

      // 7. The pre-image was taken before the write, and says the slot was empty.
      const pre = JSON.parse(
        readFileSync(join(harness.dataDir, 'writer', 'pre', 'ch65.json'), 'utf8'),
      ) as { state: string; sha: string | null; chapter: number };
      expect(pre).toMatchObject({ chapter: CHAPTER, state: 'absent', sha: null });

      // 8. One log line per stage, each with the stage's own summary — never the prompt.
      expect(harness.logs.filter((line) => line.includes('queued'))).toHaveLength(1);
      expect(harness.logs.join('\n')).not.toContain('служебный абзац');
      expect(harness.calls).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it('parks a refused answer: escalate once, one `refused` stage, the file untouched', async () => {
    const harness = await createHarness();
    try {
      harness.script.push('Извините, я не могу написать эту главу.', 'Извините, я не могу.');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      expect(result.reason).toContain('ANSWER_REFUSAL');
      expect(existsSync(join(harness.bookRoot, 'manuscript', 'ch65.md'))).toBe(false);
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');

      const stages = listStages(harness.fixture.db, CHAPTER);
      expect(stages.filter((stage) => stage.stage === 'refused')).toHaveLength(1);
      expect(stages.at(-1)?.stage).toBe('refused');
      expect(stages.at(-1)?.summary).toContain('проход остановлен');
      expect(stages.filter((stage) => stage.stage === 'landed')).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('answers a consultant blocker with exactly one revision cycle, then closes', async () => {
    const harness = await createHarness();
    try {
      harness.script.push(
        chapterAnswer('Глава шестьдесят пять', 'первый'),
        'HOLDS',
        'GAP\nblocker · глава 65, «служебный абзац» · повтор вместо прозы · переписать абзац',
        chapterAnswer('Глава шестьдесят пять', 'правка'),
        'HOLDS',
        'HOLDS',
      );
      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');

      const step = stepRow(harness.fixture, result.stepId ?? '');
      expect(step?.cycle).toBe(1);

      const revisions = harness.fixture.db
        .prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?')
        .get(CHAPTER) as { n: number };
      expect(revisions.n).toBe(2);

      const stages = listStages(harness.fixture.db, CHAPTER);
      expect(stages.filter((stage) => stage.stage === 'verdict')).toHaveLength(4);
      expect(stages.filter((stage) => stage.stage === 'landed')).toHaveLength(1);
      expect(stages.some((stage) => stage.summary.includes('консультант: GAP · замечаний 1 · блокеров 1'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('keeps writing while the chapter is thin, and stops when the budget says so', async () => {
    const harness = await createHarness({ env: { WRITER_CONTINUE_MAX: '2' } });
    try {
      harness.script.push(
        chapterAnswer(),
        `Глава шестьдесят пять\n\n${'Дописанный абзац. '.repeat(60)}`,
        'Дописанный абзац продолжается, но глава всё ещё тонкая.',
        'HOLDS',
        'HOLDS',
      );
      const result = await harness.run({ chapter: CHAPTER });
      expect(result.reason ?? '').toBe('');

      const stages = listStages(harness.fixture.db, CHAPTER);
      const drafting = stages.filter((stage) => stage.stage === 'drafting');
      // The first draft (start + return) and two continuations, each (start + return).
      expect(drafting).toHaveLength(6);
      expect(drafting[2]?.summary).toContain('продолжение');
      expect(harness.calls[1]?.messages.at(-1)?.content).toContain('Продолжи прозу ровно с этого места.');
      const written = readFileSync(join(harness.bookRoot, 'manuscript', 'ch65.md'), 'utf8');
      expect(written).toContain('Дописанный абзац.');
      expect(written).toContain('Дописанный абзац продолжается');
    } finally {
      await harness.close();
    }
  });

  it('resumes a landed step at the gates instead of writing it again', async () => {
    const harness = await createHarness();
    try {
      // The writer that opened this pass is gone after the landing: the text is on disk and the
      // step is open, so the next pass must close it, not rewrite it.
      const assignment = harness.assignment(CHAPTER);
      harness.fixture.engine.start(assignment.leaseId);
      harness.fixture.writeChapter(CHAPTER, chapterAnswer());
      harness.fixture.engine.land(assignment.leaseId);
      const onDisk = readFileSync(join(harness.bookRoot, 'manuscript', 'ch65.md'), 'utf8');

      harness.script.push('HOLDS', 'HOLDS');
      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');
      expect(readFileSync(join(harness.bookRoot, 'manuscript', 'ch65.md'), 'utf8')).toBe(onDisk);
      // No model call wrote prose: only the two gates answered.
      expect(harness.calls.map((call) => call.messages[0]?.content.slice(0, 2))).toHaveLength(2);
      expect(listStages(harness.fixture.db, CHAPTER).map((stage) => stage.stage)).toEqual([
        'queued',
        'verdict',
        'verdict',
        'landed',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('answers a dry run with the plan and never touches the engine', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.run({ chapter: 5, dryRun: true });
      expect(result.status).toBe('refused');
      expect(result.reason).toContain('dry-run');
      expect(harness.calls).toHaveLength(0);
      // Nothing was opened: no step, no lease, no stage.
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM pass_stages').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
  });

  it('answers idle for a day whose cap the estimate would cross, and opens nothing', async () => {
    const harness = await createHarness();
    try {
      // $9.99 of $10 spent: a pass costs ≈ $0.20 before the prompt is built, so it does not fit.
      harness.hooks.budget = budgetOf({ daySpent: 9.99 });
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('idle');
      expect(result.reason).toBe(PAUSE_LINE);
      // No job was asked for: the guard ran on `state` alone.
      expect(harness.engineCalls).toEqual(['state']);
      expect(harness.calls).toHaveLength(0);
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM pass_stages').get()).toEqual({ n: 0 });
      // The estimate is printed, with the day and the book it was measured against.
      expect(
        harness.logs.some((line) =>
          line.includes('оценка прохода $0,2000 (день 9,99 / 10,00, книга 9,99 / 1\u00A0000,00)'),
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('answers idle with the stop line when the estimate would spend the book’s last dollars', async () => {
    const harness = await createHarness();
    try {
      // A whole pass no longer fits into the book's last dollar: stopped, not paused, and not
      // for the day — the book ends here.
      harness.hooks.budget = budgetOf({ daySpent: 0, bookSpent: 999.99 });
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('idle');
      expect(result.reason).toBe(STOP_LINE);
      expect(harness.engineCalls).toEqual(['state']);
      expect(harness.calls).toHaveLength(0);
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
  });

  it('answers idle with the stop line when the book’s cap is reached, and opens nothing', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = budgetOf({ daySpent: 3.2, bookSpent: 1_000, state: 'stop', line: STOP_LINE });
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('idle');
      expect(result.reason).toBe(STOP_LINE);
      expect(harness.engineCalls).toEqual(['state']);
      expect(harness.calls).toHaveLength(0);
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
  });

  it('opens the pass on a fresh day and prices it before the first call', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = budgetOf({ daySpent: 0 });
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('closed');
      // The guard, then the job; the ledger is read once more before the first model call.
      expect(harness.engineCalls.slice(0, 2)).toEqual(['state', 'pass']);
      expect(harness.engineCalls.filter((name) => name === 'state')).toHaveLength(2);
      expect(harness.engineCalls.indexOf('state', 1)).toBeGreaterThan(harness.engineCalls.indexOf('start'));
      expect(harness.logs.some((line) => line.includes('оценка прохода $0,2000'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('parks the pass before any provider call when the real prompt crosses the cap', async () => {
    const harness = await createHarness();
    try {
      // The ledger is shared: this pass was priced on an empty day, and another lane spent the
      // headroom while it was being opened. The belt prices the real prompt and stops at once.
      harness.hooks.budget = budgetOf({ daySpent: 0 });
      harness.hooks.beforeCall = (name) => {
        if (name === 'pass') {
          harness.hooks.budget = budgetOf({ daySpent: 9.99, state: 'pause', line: PAUSE_LINE });
        }
      };
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      expect(result.reason).toBe(PAUSE_LINE);
      expect(harness.engineCalls).toContain('pass');
      expect(harness.engineCalls).toContain('escalate');
      // Nothing was spent: the provider was never called.
      expect(harness.calls).toHaveLength(0);
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');
      expect(existsSync(join(harness.bookRoot, 'manuscript', 'ch65.md'))).toBe(false);
      expect(listStages(harness.fixture.db, CHAPTER).map((stage) => stage.stage)).toEqual([
        'queued',
        'read',
        'refused',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('parks the opened pass when the book’s last dollars went while it was being opened', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = budgetOf({ daySpent: 0, bookSpent: 0 });
      harness.hooks.beforeCall = (name) => {
        if (name === 'pass') {
          harness.hooks.budget = budgetOf({ daySpent: 1.5, bookSpent: 999.99, state: 'stop', line: STOP_LINE });
        }
      };
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('parked');
      // The book ends here: the engine's own stop sentence is the reason.
      expect(result.reason).toBe(STOP_LINE);
      expect(harness.calls).toHaveLength(0);
      expect(listStages(harness.fixture.db, CHAPTER).at(-1)?.stage).toBe('refused');
    } finally {
      await harness.close();
    }
  });

  it('proceeds when the engine reports no budget, and says the bound is unavailable', async () => {
    const harness = await createHarness();
    try {
      harness.hooks.budget = null;
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });

      expect(result.status).toBe('closed');
      expect(harness.logs.some((line) => line.includes('бюджет недоступен'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('keeps the pass running when the ledger cannot be re-read before the first call', async () => {
    // The guard price already passed and nothing was spent; a failed re-read is logged, not
    // turned into a refusal that hides the truth (a provider call still needs a live engine).
    const first = await createHarness();
    try {
      let stated = 0;
      first.hooks.beforeCall = (name) => {
        if (name !== 'state') return;
        stated += 1;
        if (stated > 1) throw new Error('the ledger is unreadable');
      };
      first.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      expect((await first.run({ chapter: CHAPTER })).status).toBe('closed');
      expect(first.logs.some((line) => line.includes('пересчёт оценки не выполнен'))).toBe(true);
    } finally {
      await first.close();
    }

    // An engine that stops reporting money mid-pass is the same story: the pass goes on.
    const second = await createHarness();
    try {
      second.hooks.beforeCall = (name) => {
        if (name === 'pass') second.hooks.budget = null;
      };
      second.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      expect((await second.run({ chapter: CHAPTER })).status).toBe('closed');
    } finally {
      await second.close();
    }
  });

  it('says the day’s tokens once at boot, as information and not as a bound', async () => {
    const harness = await createHarness({ env: { WRITER_DAILY_TOKENS: '1' } });
    try {
      const lines: string[] = [];
      const code = await main({ argv: ['--dry-run'], env: harness.env, log: (line) => lines.push(line) });
      expect(code).toBe(0);
      expect(lines.filter((line) => line.includes('токены:'))).toHaveLength(1);
      expect(lines.join('\n')).toContain('токены: 1 за сутки');
      expect(lines.join('\n')).toContain('информация, не граница');
    } finally {
      await harness.close();
    }
  });

  it('no longer stops on a day’s tokens: the bound is money, tokens are information', async () => {
    const harness = await createHarness({ env: { WRITER_DAILY_TOKENS: '10' } });
    try {
      harness.fixture.db
        .prepare(
          `INSERT INTO steps (step_id, seq, wave, pass, chapter, boundary, at, outcome, tokens_in, tokens_out)
           VALUES ('stp_spent', 0, 0, 'draft', 1, 'front', ?, 'rewritten', 90, 20)`,
        )
        .run(toIso(harness.fixture.clock.now()));
      const state = await harness.client.state();
      expect(state.tokens.today).toBeGreaterThan(harness.config.dailyTokens);

      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
    } finally {
      await harness.close();
    }
  });
});
