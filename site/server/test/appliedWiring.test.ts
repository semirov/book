/**
 * BOOK-220 — the bridge the **site** builds, end to end.
 *
 * The defect this file guards: `index.ts` built `EngineBridge` without `dataDir`, so every
 * production `chapter:applied` was `patchTruncated: true, patch: [], span: null` — the write was
 * published and the print silently never happened. `applied.ts` derives the patch and span from
 * the two revision snapshots under `<dataDir>/versions/…`, and `index.ts` is outside coverage, so
 * no test spoke about the construction at all.
 *
 * Here the bridge comes from `createEngineBridge` — the one factory `index.ts` uses — with the
 * deployment's own `config`, and the write lands through the engine's own path (`land`), which
 * writes its snapshot into the same store. A hand-made `new EngineBridge({ dataDir })` would have
 * hidden the omission again, so it is not used here on purpose.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEngineBridge } from '../src/engineState/wiring.ts';
import { createEngineFixture, fileOn, runStubStep } from './engine/helpers.ts';
import { longProse } from './helpers.ts';

type Frame = { type: string; data: Record<string, unknown> };

function framesOf(type: string, frames: Frame[]): Frame[] {
  return frames.filter((frame) => frame.type === type);
}

describe('the site’s bridge is built from config (BOOK-220)', () => {
  it('publishes a landed write with its patch and span, read from the configured data dir', () => {
    const fixture = createEngineFixture({ chapters: { 5: longProse(['Первый служебный абзац главы.']) } });
    try {
      const frames: Frame[] = [];
      const bridge = createEngineBridge({
        config: fixture.config,
        db: fixture.db,
        emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
      });
      bridge.prime();

      fileOn(fixture, 5);
      const run = runStubStep(fixture, { blocks: ['Первый служебный абзац главы.', 'Второй абзац после прохода.'] });
      bridge.tick();

      const chapter = run?.assignment.chapter ?? 5;
      const applied = framesOf('chapter:applied', frames).at(-1);
      expect(applied, 'chapter:applied was published').toBeDefined();
      expect(applied?.data).toMatchObject({ n: chapter, patchTruncated: false });
      // A frame with no patch and no span prints nothing: both must be real here.
      expect((applied?.data.patch as unknown[]).length).toBeGreaterThan(0);
      expect((applied?.data.span as unknown[]).length).toBeGreaterThan(0);

      // The snapshot the frame read is the one the store holds, under the config's data dir.
      const row = fixture.db
        .prepare('SELECT snapshot FROM revisions WHERE chapter = ? AND rev = ?')
        .get(chapter, applied?.data.rev as number) as { snapshot: string } | undefined;
      expect(row).toBeDefined();
      expect(existsSync(join(fixture.config.dataDir, row!.snapshot))).toBe(true);
      expect(fixture.config.dataDir).toBe(fixture.dataDir);
    } finally {
      fixture.close();
    }
  });

  it('announces the lane’s day bound from config, not the bridge’s own default', () => {
    const fixture = createEngineFixture({ env: { WRITER_MAX_PASSES_PER_DAY: '6' } });
    try {
      const frames: Frame[] = [];
      const bridge = createEngineBridge({
        config: fixture.config,
        db: fixture.db,
        emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
      });
      // Prime at `absent`, then make the engine heartbeat so the status transition is a frame.
      bridge.prime();
      fixture.db
        .prepare(`INSERT INTO meta (k, v) VALUES ('engine.heartbeat', ?), ('engine.status', 'running')`)
        .run(new Date().toISOString());
      bridge.tick();

      const state = framesOf('engine:state', frames).at(-1);
      expect(fixture.config.writerMaxPasses).toBe(6);
      expect(state?.data).toMatchObject({ status: 'running', maxPasses: 6 });
    } finally {
      fixture.close();
    }
  });
});
