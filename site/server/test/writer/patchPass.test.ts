/**
 * The patch path end to end (BOOK-173 §2–§5), through the same fixture engine and scripted
 * provider a rewrite pass uses.
 *
 * What is asserted is what a reader could see: the file (only the named span moved, every other
 * block byte-identical), the stages (the mode on the `read` line), the transcript (the mode, the
 * prefix and the patch's own numbers) and the close (`done`). Refusals are rows too: a patch over
 * the frame and a patch over the budget both park with their own code and leave the file alone.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { parseChapter } from '../../src/ingest/parseChapter.ts';
import { listStages } from '../../src/stages/repo.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { chapterAnswer, createHarness, stepRow, type Harness } from './harness.ts';
import { inertParagraph } from './inert.ts';

const CHAPTER = 12;

function para(marker: string, chars = 600): string {
  return inertParagraph(marker, chars);
}

function chapterFile(harness: Harness): string {
  return join(harness.bookRoot, 'manuscript', `ch${String(CHAPTER).padStart(2, '0')}.md`);
}

/** A written chapter the harness knows about, plus a phrase-scope filing on it. */
async function written(overrides: { text?: string; chapter?: number; intent?: string } = {}): Promise<Harness> {
  const chapter = overrides.chapter ?? CHAPTER;
  const text =
    overrides.text ?? `Глава двенадцатая\n\n${[para('Первый абзац.'), para('Гуси шли по льду.'), para('Третий абзац.'), para('Четвёртый абзац.')].join('\n\n')}\n`;
  const harness = await createHarness({ chapters: { [chapter]: text } });
  harness.ingest(chapter);
  harness.fixture.engine.enqueue({
    kind: 'operator',
    chapter,
    intent: 'в главе 12 гуси меняются на часы',
    scopeHint: 'phrase',
  });
  return harness;
}

function answer(blockId: string, oldText: string, newText: string, facts: string[] = []): string {
  return JSON.stringify({ mode: 'patch', edits: [{ blockId, oldText, newText }], facts, note: 'phrase scope' });
}

describe('a phrase-scope filing on a written chapter applies a patch', () => {
  it('lands only the named span, keeps every untouched block byte-identical, and closes the step', async () => {
    const harness = await written();
    try {
      const before = parseChapter(CHAPTER, readFileSync(chapterFile(harness), 'utf8'));
      const target = before.blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      harness.script.push(answer(target.id, 'Гуси шли по льду.', 'Часы шли по кругу.', ['Часы шли по кругу.']), 'HOLDS', 'HOLDS');

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');

      // 1. The file: the named span changed, nothing else did.
      const after = parseChapter(CHAPTER, readFileSync(chapterFile(harness), 'utf8'));
      expect(after.text).toContain('Часы шли по кругу.');
      expect(after.text).not.toContain('Гуси шли по льду.');
      expect(after.blocks).toHaveLength(before.blocks.length);
      for (const index of [0, 2, 3]) {
        expect(after.blocks[index]?.hash, `block ${String(index)}`).toBe(before.blocks[index]?.hash);
        expect(after.blocks[index]?.text).toBe(before.blocks[index]?.text);
      }
      expect(after.title).toBe(before.title);

      // 2. The stages: the read line names the mode, and the landed line says which gates judged
      //    the change — BOOK-DOC-80: an isolated clean patch is read locally, so the pair never
      //    speaks and Gate B is the one verdict (a clean scan, no model call).
      const stages = listStages(harness.fixture.db, CHAPTER);
      expect(stages.map((stage) => stage.stage)).toEqual(['queued', 'read', 'drafting', 'drafting', 'verdict', 'landed']);
      expect(stages[1]?.summary).toContain('режим: правка (заявка про фразу)');
      expect(stages.at(-1)?.summary).toContain('гейты: локально');

      // 3. The transcript: the mode, the prefix every call was sent under, the patch's numbers.
      const transcript = JSON.parse(
        readFileSync(join(harness.dataDir, 'writer', 'transcripts', `${result.stepId ?? ''}.json`), 'utf8'),
      ) as {
        mode: string;
        cachePrefix: string;
        patch: { edits: number; changedChars: number; fraction: number; facts: number };
        gates: { gatesMode: string; why: string | null; tier1Verdict: string | null; tier1Usd: number | null; line: string };
        calls: Array<{ kind: string; system: string; prefixSha256: string; cachedIn: number }>;
      };
      expect(transcript.mode).toBe('patch');
      // BOOK-DOC-80: the record is not silent about the gates it did not run.
      expect(transcript.gates.gatesMode).toBe('local only');
      expect(transcript.gates.tier1Verdict).toBe('HOLDS');
      expect(transcript.gates.line).toBe('gates: local only');
      expect(transcript.gates.tier1Usd).toBeGreaterThan(0);
      expect(transcript.cachePrefix).toMatch(/^[0-9a-f]{64}$/u);
      expect(transcript.patch.edits).toBe(1);
      expect(transcript.patch.facts).toBe(1);
      expect(transcript.patch.changedChars).toBe('Часы шли по кругу.'.length);
      expect(transcript.patch.fraction).toBeGreaterThan(0);
      // The writer's own call is sent under the pass's prefix; the gates have their own.
      const draft = transcript.calls.find((call) => call.kind === 'draft');
      expect(draft?.prefixSha256).toBe(sha256Hex(draft?.system ?? ''));
      expect(draft?.prefixSha256).toBe(transcript.cachePrefix);
      for (const call of transcript.calls) expect(call.prefixSha256).toBe(sha256Hex(call.system));

      // 4. The close: the change settled as applied, and exactly one model call was made after
      //    the patch — the local judge. No editor, no consultant (BOOK-DOC-80).
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('rewritten');
      expect(harness.calls.map((call) => call.messages.length)).toEqual([2, 2]);
      expect(transcript.calls.map((call) => call.kind)).toEqual(['draft', 'tier1']);
      const record = harness.fixture.db
        .prepare('SELECT gates_mode, tier1_verdict, tier1_usd, sample_requested FROM change_plans')
        .get() as { gates_mode: string; tier1_verdict: string; tier1_usd: number; sample_requested: number };
      expect(record.gates_mode).toBe('local only');
      expect(record.tier1_verdict).toBe('HOLDS');
      expect(record.tier1_usd).toBe(transcript.gates.tier1Usd);
      expect(record.sample_requested).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('records the mode and the price with the plan, and the actual replaces the estimate at close', async () => {
    const harness = await written();
    try {
      const before = parseChapter(CHAPTER, readFileSync(chapterFile(harness), 'utf8'));
      const target = before.blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      harness.script.push(answer(target.id, 'Гуси шли по льду.', 'Часы шли по кругу.'), 'HOLDS', 'HOLDS');

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');
      // BOOK-173 §4: the plan of a change carries how the pass wrote and what it was priced at —
      // one row, written inside the landing's transaction.
      const plan = harness.fixture.db
        .prepare('SELECT mode, price_usd FROM change_plans ORDER BY created_at DESC LIMIT 1')
        .get() as { mode: string | null; price_usd: number | null } | undefined;
      expect(plan?.mode).toBe('patch');
      const spend = harness.fixture.db
        .prepare('SELECT usd FROM pass_spend WHERE pass_id = ?')
        .get(result.stepId ?? '') as { usd: number } | undefined;
      expect(spend?.usd).toBeGreaterThan(0);
      // The close replaced the estimate with the pass's actual: the plan is not a second ledger.
      expect(plan?.price_usd).toBe(spend?.usd);
    } finally {
      await harness.close();
    }
  });

  it('obeys a model that answers mode:"rewrite": a rewrite in the same pass, no patch retry', async () => {
    const harness = await written();
    try {
      harness.script.push(
        JSON.stringify({ mode: 'rewrite', note: 'the number 257 changes' }),
        chapterAnswer('Глава двенадцатая', 'переписано'),
        'HOLDS',
        'HOLDS',
      );
      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');
      expect(readFileSync(chapterFile(harness), 'utf8')).toContain('переписано');
      const stages = listStages(harness.fixture.db, CHAPTER);
      // The mode the pass chose is «правка»; the model's decline is what the transcript records.
      expect(stages[1]?.summary).toContain('режим: правка (заявка про фразу)');
      const transcript = JSON.parse(
        readFileSync(join(harness.dataDir, 'writer', 'transcripts', `${result.stepId ?? ''}.json`), 'utf8'),
      ) as { mode: string; patch: unknown };
      expect(transcript.mode).toBe('rewrite');
      expect(transcript.patch).toBeNull();
      // The decline was read, not repaired: the second call is the rewrite draft.
      expect(harness.calls).toHaveLength(4);
    } finally {
      await harness.close();
    }
  });
});

describe('a patch that cannot be proved parks instead of landing', () => {
  it('parks with FRAME_CHANGED when the edit overlaps ch01’s frozen sentence', async () => {
    const text = `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${para('Второй абзац.')}\n\n${para('Третий абзац.')}\n\n${para('Четвёртый абзац.')}\n`;
    const harness = await written({ chapter: 1, text, intent: 'в главе 1 меняется свет' });
    try {
      const original = readFileSync(join(harness.bookRoot, 'manuscript', 'ch01.md'), 'utf8');
      const target = parseChapter(1, original).blocks[0];
      if (target === undefined) throw new Error('the fixture chapter has no first block');
      const bad = answer(target.id, 'яркий свет', 'тусклый свет');
      // The refusal buys exactly one repair turn; the same patch twice is a parked pass.
      harness.script.push(bad, bad);

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(harness.logs.join('\n')).toContain('FRAME_CHANGED');
      expect(readFileSync(join(harness.bookRoot, 'manuscript', 'ch01.md'), 'utf8')).toBe(original);
      const stages = listStages(harness.fixture.db, 1);
      expect(stages.at(-1)?.stage).toBe('refused');
      expect(stages.filter((stage) => stage.stage === 'landed')).toHaveLength(0);
      expect(stepRow(harness.fixture, result.stepId ?? '')?.outcome).toBe('escalated');
      // The repair is a turn in the same session: same prefix, one more answer.
      expect(harness.calls).toHaveLength(2);
      expect(harness.calls[1]?.messages[0]?.content).toBe(harness.calls[0]?.messages[0]?.content);
      expect(harness.calls[1]?.messages).toHaveLength(4);
    } finally {
      await harness.close();
    }
  });

  it('parks with PATCH_REJECTED:<CODE> when the patched chapter breaks a prose rule', async () => {
    const harness = await written();
    try {
      const original = readFileSync(chapterFile(harness), 'utf8');
      const target = parseChapter(CHAPTER, original).blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      harness.script.push(answer(target.id, 'Гуси шли по льду.', '**Часы** шли по кругу.'));

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      // The one prose judge is `validateAnswer`, reused: its code is named, never re-invented.
      expect(harness.logs.join('\n')).toContain('PATCH_REJECTED:MARKDOWN');
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(original);
      // A validator refusal is final: no repair turn, one call only.
      expect(harness.calls).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('parks with PATCH_FACT_LOST when the patch asserts a fact the chapter will not carry', async () => {
    const harness = await written();
    try {
      const original = readFileSync(chapterFile(harness), 'utf8');
      const target = parseChapter(CHAPTER, original).blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      const bad = answer(target.id, 'Гуси шли по льду.', 'Часы шли по кругу.', ['документ о допуске']);
      harness.script.push(bad, bad);

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(harness.logs.join('\n')).toContain('PATCH_FACT_LOST');
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(original);
    } finally {
      await harness.close();
    }
  });

  it('parks with PATCH_NEIGHBOUR_MOVED when a neighbour lands between the prompt and the write', async () => {
    const text = `Глава двенадцатая\n\n${[para('Первый абзац.'), para('Гуси шли по льду.'), para('Третий абзац.'), para('Четвёртый абзац.')].join('\n\n')}\n`;
    const harness = await written({ text });
    try {
      writeFileSync(join(harness.bookRoot, 'manuscript', 'ch11.md'), 'Глава одиннадцать\n\nСосед до.\n');
      const original = readFileSync(chapterFile(harness), 'utf8');
      const target = parseChapter(CHAPTER, original).blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      // The neighbour lands while the model is being asked: the prompt was built from another book.
      let moved = false;
      harness.hooks.beforeCall = (name) => {
        if (name !== 'beat' || moved) return;
        moved = true;
        writeFileSync(join(harness.bookRoot, 'manuscript', 'ch11.md'), 'Глава одиннадцать\n\nСосед до — правка.\n');
      };
      harness.script.push(answer(target.id, 'Гуси шли по льду.', 'Часы шли по кругу.'));

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(harness.logs.join('\n')).toContain('PATCH_NEIGHBOUR_MOVED');
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(original);
    } finally {
      await harness.close();
    }
  });

  it('parks with PATCH_BUDGET_EXCEEDED when the edit is over 15 % of the chapter', async () => {
    // 4 200 characters, so a 1 000-character edit is ~24 % — over the bound, inside one quote.
    const long = para('Гуси шли по льду.', 2_000);
    const text = `Глава двенадцатая\n\n${para('Первый абзац.', 800)}\n\n${long}\n\n${para('Третий абзац.', 700)}\n\n${para('Четвёртый абзац.', 700)}\n`;
    const harness = await written({ text });
    try {
      const original = readFileSync(chapterFile(harness), 'utf8');
      const target = parseChapter(CHAPTER, original).blocks[1];
      if (target === undefined) throw new Error('the fixture chapter has no second block');
      // 1 000 of ~4 200 characters is a rewrite of a quarter, not a patch.
      const bad = answer(target.id, long.slice(0, 1_000), 'Абзац покороче.');
      harness.script.push(bad, bad);

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(harness.logs.join('\n')).toContain('PATCH_BUDGET_EXCEEDED');
      expect(readFileSync(chapterFile(harness), 'utf8')).toBe(original);
      expect(listStages(harness.fixture.db, CHAPTER).filter((stage) => stage.stage === 'landed')).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
