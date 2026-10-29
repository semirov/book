/**
 * The tiered pass, end to end (BOOK-DOC-80): what the pass does when the table says `full`, and
 * what it does when Tier 0 refuses.
 *
 * The other two cases of the design live where they happen: an isolated clean patch runs one model
 * call and records `gates: local only` (`patchPass.test.ts`), and a non-empty closure runs the pair
 * (`ripple/planAtLand.test.ts`). This file pins the two that need a chapter's own geometry:
 *
 *   · the changed span in the chapter's **first 600 characters** — an opening is structure, so the
 *     pair reads the chapter;
 *   · a Tier-0 failure — the pass parks with the code, **before** a byte is written and before any
 *     model but the one that wrote the patch is asked.
 */


import { describe, expect, it } from 'vitest';

import { STOP_REASONS } from '@book/shared';

import { parseChapter } from '../../../src/ingest/parseChapter.ts';
import { createHarness, receiptsOf, type Harness } from '../harness.ts';
import { inertParagraph } from '../inert.ts';

const CHAPTER = 12;

/** The chapter as the site serves it: rows, never a file (BOOK-187). */
function chapterText(harness: Harness, chapter = CHAPTER): string {
  return harness.fixture.readChapter(chapter) ?? '';
}

/** A written chapter with a phrase-scope filing on it. Its first paragraph is the chapter's edge. */
async function written(): Promise<Harness> {
  const text = `Глава двенадцатая\n\n${[0, 1, 2, 3]
    .map((index) => inertParagraph(`Абзац ${String(index + 1)} стоит на месте, как и раньше.`, 560))
    .join('\n\n')}\n`;
  const harness = await createHarness({ chapters: { [CHAPTER]: text } });
  harness.ingest(CHAPTER);
  harness.fixture.engine.enqueue({
    kind: 'operator',
    chapter: CHAPTER,
    intent: 'в главе 12 меняется первая фраза',
    scopeHint: 'phrase',
  });
  return harness;
}

function answer(blockId: string, oldText: string, newText: string): string {
  return JSON.stringify({ mode: 'patch', edits: [{ blockId, oldText, newText }], facts: [], note: 'tiered' });
}

describe('a patch at the chapter’s edge runs the full pair', () => {
  it('asks the editor and the consultant, and records a full pair with its trigger', async () => {
    const harness = await written();
    try {
      const before = parseChapter(CHAPTER, chapterText(harness));
      const target = before.blocks[0];
      if (target === undefined) throw new Error('the fixture chapter has no first block');
      // The first paragraph begins a few characters after the title: inside the first 600.
      harness.script.push(answer(target.id, 'Абзац 1 стоит', 'Абзац 1 лежит'), 'HOLDS', 'HOLDS', 'HOLDS');

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');
      // One patch call, one local judge, then the pair — the edge is why the pair was asked.
      expect(harness.calls).toHaveLength(4);
      // BOOK-187 AC7: the receipt is rows — one per call, and the pass's facts on the last.
      const { rows: receiptRows, pass: receipt } = receiptsOf(harness, result.stepId ?? '');
      const transcript = {
        gates: receipt.gates as { gatesMode: string; why: string; line: string },
        calls: receiptRows.map((row) => ({ kind: row.role })),
      };
      expect(transcript.calls.map((call) => call.kind)).toEqual(['draft', 'tier1', 'gate:editor', 'gate:consultant']);
      expect(transcript.gates.gatesMode).toBe('full');
      expect(transcript.gates.why).toBe('chapter_edge');
      expect(transcript.gates.line).toBe('gates: full (правка у края главы)');
      // The record on the change agrees with the transcript, and a full pair is never sampled.
      const record = harness.fixture.db
        .prepare('SELECT gates_mode, tier1_verdict, tier1_usd, sample_requested FROM change_plans')
        .get() as { gates_mode: string; tier1_verdict: string; tier1_usd: number; sample_requested: number };
      expect(record).toMatchObject({ gates_mode: 'full', tier1_verdict: 'HOLDS', sample_requested: 0 });
      expect(record.tier1_usd).toBeGreaterThan(0);
      // The landed line says it too, so the reader's page is not silent about the gates.
      expect(harness.logs.join('\n')).toContain('гейты: полная пара (правка у края главы)');
    } finally {
      await harness.close();
    }
  });
});

describe('a Tier-0 failure parks before the text is written', () => {
  it('parks with TIER0_FAILED, leaves the file alone and asks no gate', async () => {
    const harness = await written();
    try {
      const original = chapterText(harness);
      const target = parseChapter(CHAPTER, original).blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      // Six words, twice, inside the changed span: the one invariant a rule can settle.
      const repeated = 'И снова сторож вышел на лёд. И снова сторож вышел на лёд.';
      harness.script.push(answer(target.id, 'стоит на месте', repeated));

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(result.code).toBe('TIER0_FAILED');
      // The register's one stop line (BOOK-218); the code word stays in the log below.
      expect(result.reason).toBe(STOP_REASONS.stopped);
      expect(harness.logs.join('\n')).toContain('TIER0_REPEAT');
      // The chapter is the pre-image: no write, no landing, no gate, no second model call.
      expect(chapterText(harness)).toBe(original);
      expect(harness.calls).toHaveLength(1);
      expect(harness.engineCalls).not.toContain('nextGate');
      expect(harness.engineCalls).not.toContain('land');
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM change_plans').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
  });
});
