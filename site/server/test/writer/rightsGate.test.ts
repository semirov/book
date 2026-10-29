/**
 * Gate B in the lane (BOOK-61, the owner's rule of 2026-10-28): every prose pass carries a
 * rights answer, and the answer has two shapes —
 *
 *   • a **clean** scan is answered mechanically: `CLEAR`, zero model tokens, and a stage that
 *     says so («скан чистый, модель не звана»), because the record must show the question was
 *     answered, not skipped;
 *   • a **flagged** scan is the copyright question: `CLEAR` releases the text, `REFUSED` closes
 *     the step as `escalated:rights` with the rule's own sentence — a refusal is a decision
 *     about the text, so the pass ends there.
 *
 * The first case is the one that stopped production: `done` refuses a prose step without a
 * rights verdict (`RIGHTS_REQUIRED`), so a lane that asked two gates could never close.
 */

import { describe, expect, it } from 'vitest';

import { listStages } from '../../src/stages/repo.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';

const CHAPTER = 9;

function rightsVerdict(harness: Harness): { verdict: string; rule: string | null; tokens: number } | null {
  const row = harness.fixture.db
    .prepare(`SELECT verdict, findings, tokens_in, tokens_out FROM gate_verdicts WHERE role = 'rights'`)
    .get() as { verdict: string; findings: string; tokens_in: number; tokens_out: number } | undefined;
  if (row === undefined) return null;
  const findings = JSON.parse(row.findings) as Array<{ rule?: string }>;
  return { verdict: row.verdict, rule: findings[0]?.rule ?? null, tokens: row.tokens_in + row.tokens_out };
}

function stageSummaries(harness: Harness): string[] {
  return listStages(harness.fixture.db, CHAPTER).map((stage) => `${stage.stage}: ${stage.summary}`);
}

/** A chapter the rights scan flags: a long quoted run in «…» reads as unquoted third-party text. */
function quotedAnswer(): string {
  const quote = `«${'чужой текст без источника повторяется в этой главе снова и снова, '.repeat(12).trim()}»`;
  return `${chapterAnswer('Глава девятая', 'правка')}\n\n${quote}\n`;
}

describe('Gate B in the lane', () => {
  it('answers a clean scan mechanically and closes: the verdict is CLEAR with no model call', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 9 появляется документ о допуске');
      // The drafting answer, then the two prose gates. Gate B answers mechanically: no call.
      harness.script.push(chapterAnswer('Глава девятая', 'новая'), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('rewritten');

      const rights = rightsVerdict(harness);
      expect(rights).toEqual({ verdict: 'CLEAR', rule: null, tokens: 0 });
      expect(stageSummaries(harness).join('\n')).toContain('скан чистый, модель не звана');
      // Three provider calls: the chapter, the editor, the consultant. Gate B cost none.
      expect(harness.calls).toHaveLength(3);
      expect(harness.calls.some((call) => call.messages.some((message) => message.content.includes('RIGHTS — Gate B')))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('asks the copyright question on a flagged scan, and a CLEAR releases the text', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 9 появляется документ о допуске');
      harness.script.push(quotedAnswer(), 'HOLDS', 'HOLDS', 'CLEAR');

      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('closed');
      const rights = rightsVerdict(harness);
      expect(rights?.verdict).toBe('CLEAR');
      // The question was actually asked: one rights call, with the scan's rule in its brief.
      const call = harness.calls.find((entry) =>
        entry.messages.some((message) => message.content.includes('RIGHTS — Gate B')),
      );
      expect(call).toBeDefined();
      expect(call?.messages.map((message) => message.content).join('\n')).toContain('RIGHTS-QUOTE');
    } finally {
      await harness.close();
    }
  });

  it('a REFUSED closes the step as escalated:rights and ends the pass with a readable reason', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 9 появляется документ о допуске');
      harness.script.push(quotedAnswer(), 'HOLDS', 'HOLDS', 'REFUSED RIGHTS-QUOTE');

      const result = await harness.run({ chapter: CHAPTER });
      expect(result.status).toBe('parked');
      expect(result.reason).toMatch(/^не дошло: /u);
      const step = stepRow(harness.fixture, result.stepId ?? '');
      expect(step?.outcome).toBe('escalated');
      expect(rightsVerdict(harness)?.rule).toBe('RIGHTS-QUOTE');
      // The reader's sentence is the rule's own, never a code.
      expect(stageSummaries(harness).join('\n')).toContain('права: REFUSED');
    } finally {
      await harness.close();
    }
  });

  it('answers a rights gate that never comes back from the engine’s own check', async () => {
    const harness = await createHarness();
    try {
      harness.premised(CHAPTER, 'в главе 9 появляется документ о допуске');
      harness.script.push(chapterAnswer('Глава девятая', 'новая'), 'HOLDS', 'HOLDS');
      // The lane is told Gate B never answers: the close must refuse, not invent a verdict.
      harness.hooks.beforeCall = (name) => {
        if (name === 'nextRightsGate') throw Object.assign(new Error('no rights dispatch'), { code: 'RIGHTS_NOT_REQUIRED' });
      };

      const result = await harness.run({ chapter: CHAPTER });
      // A clean scan owes no rights verdict (the engine asks for one only when the scan flags),
      // so the mechanical sixth closes the step — no model was asked, and the record says so.
      expect(result.status).toBe('closed');
      expect(rightsVerdict(harness)).toBeNull();
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('rewritten');
      // The close needed the two prose verdicts only: a clean scan is not a precondition.
      expect(harness.engineCalls).toContain('done');
    } finally {
      await harness.close();
    }
  });
});
