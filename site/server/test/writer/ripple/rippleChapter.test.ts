/**
 * One ripple chapter as a normal pass (BOOK-173, BOOK-DOC-75 §7) — the drainer's real runner.
 *
 * The step is opened by the engine's own ripple door (`pass: 'cascade'`, its own lease and gates),
 * the prompt carries the synthetic assignment as a fenced data block beside the chapter's own
 * blocks, and the chapter lands through the same `land` every pass uses. The door's refusals are
 * asserted too: a chapter the plan does not name, and a change that is not a ripple.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { latestPlan } from '../../../src/engine/ripple.ts';
import { runPass } from '../../../src/writer/pass.ts';
import { EngineRefusalError, createEngineClient } from '../../../src/writer/client.ts';
import { blockOf, rippleGraph, rippleHarness, statusPatch } from './fixtures.ts';

const RIPPLE_CHAPTER = 12;

/** The patch the scripted model returns for ch12: the same status word, in the consequence. */
function consequencePatch(): string {
  return JSON.stringify({
    mode: 'patch',
    edits: [{ blockId: 'BLOCK', oldText: 'выдан', newText: 'аннулирован' }],
    facts: [],
    note: 'the premise moved',
  });
}

describe('a ripple chapter', () => {
  it('opens its own step, patches its block through the data block, and closes', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const changeId = (
        harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = 5 AND status = 'pending'`).get() as {
          id: string;
        }
      ).id;
      // The patch, the causality judge, the local judge, then the pair (a non-empty closure).
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');

      // The ripple's own door: one chapter, its own step, the change it serves.
      const engine = createEngineClient({ baseUrl: harness.config.engineUrl, tokenFile: harness.tokenFile });
      const block = blockOf(harness.fixture.db, RIPPLE_CHAPTER, 0);
      harness.script.push(consequencePatch().replace('BLOCK', block.id), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');
      const result = await runPass({
        config: harness.config,
        bookRoot: harness.bookRoot,
        engine,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => harness.logs.push(line),
        chapter: null,
        ripple: {
          chapter: RIPPLE_CHAPTER,
          changeId,
          reason: 'CAUSE_CHANGED:edg_doc_12',
          claim: '«Допуск всё ещё выдан, и смена стоит.»',
        },
      });

      expect(result.status).toBe('closed');
      const step = harness.fixture.db
        .prepare('SELECT pass, chapter, outcome FROM steps WHERE step_id = ?')
        .get(result.stepId ?? '') as { pass: string; chapter: number; outcome: string };
      expect(step).toEqual({ pass: 'cascade', chapter: RIPPLE_CHAPTER, outcome: 'rewritten' });
      // The prose moved where the plan said it would, and only there — in the rows.
      const text = harness.fixture.readChapter(RIPPLE_CHAPTER);
      expect(text).toContain('аннулирован');
      expect(text).not.toContain('Допуск всё ещё выдан');
      // BOOK-187: the receipt is rows, and no pass wrote a file under the data dir.
      expect(existsSync(join(harness.dataDir, 'writer'))).toBe(false);
      const receipts = harness.fixture.db
        .prepare('SELECT role, content_redacted FROM pass_transcripts WHERE pass_id = ? ORDER BY seq')
        .all(result.stepId ?? '') as Array<{ role: string; content_redacted: string }>;
      expect(receipts.map((row) => row.role)).toContain('draft');
      // The pass's own facts travel on its last row, so the mode is read there.
      const lastRow = receipts.at(-1);
      const draft = JSON.parse(lastRow?.content_redacted ?? '{}') as { pass?: { mode?: string } };
      // The mode the pass ran is a fact of the receipt, and the prompt itself is only a hash.
      expect(draft.pass?.mode).toBe('patch');
      expect(receipts.map((row) => row.content_redacted).join('')).not.toContain('```ripple');
      expect(receipts.map((row) => row.content_redacted).join('')).not.toContain('Допуск всё ещё выдан');
      // Its prefix is the pass's prefix: the origin pass's cache still pays for it.
      expect(harness.fixture.db.prepare('SELECT outcome FROM changes WHERE id = ?').get(changeId)).toEqual({
        outcome: 'ripple',
      });
    } finally {
      await harness.close();
    }
  });

  it('refuses a chapter the plan does not name, and a change that is not a ripple', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const changeId = (
        harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = 5 AND status = 'pending'`).get() as {
          id: string;
        }
      ).id;
      // The patch, the causality judge, the local judge, then the pair (a non-empty closure).
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');
      const stored = latestPlan(harness.fixture.db, changeId);
      expect(stored?.plan.outcome).toBe('ripple');

      const engine = createEngineClient({ baseUrl: harness.config.engineUrl, tokenFile: harness.tokenFile });
      // ch05 is the origin, not a consequence: no plan node names it.
      await expect(engine.openRipple(5, 'writer-test', changeId)).rejects.toMatchObject({ code: 'NOT_PLANNED' });
      // A plain change is not a ripple, whatever its chapter says.
      harness.fixture.engine.enqueue({ kind: 'operator', chapter: 12, intent: 'правка', scopeHint: 'phrase' });
      const other = (
        harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = 12 AND status = 'pending'`).get() as {
          id: string;
        }
      ).id;
      await expect(engine.openRipple(12, 'writer-test', other)).rejects.toBeInstanceOf(EngineRefusalError);
      await expect(engine.openRipple(12, 'writer-test', other)).rejects.toMatchObject({ code: 'NOT_A_RIPPLE' });
    } finally {
      await harness.close();
    }
  });
});
