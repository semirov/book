/**
 * The three calls of a pass that touch the chapter's file (BOOK-173 §2/§4, BOOK-137): write the
 * text atomically, keep the pre-image a revert puts back, and land.
 *
 * They live apart from `passLane.ts` because they are the only part of a pass that talks to the
 * disk and to `land`, and because the landing now states three things the engine cannot derive:
 * **the patch's character edits** (§2 — the ingest keeps sentence ids only if it is told where
 * inside the block the write happened), **the mode** the pass ran (§4) and **the estimate** it was
 * opened with. The pass owns those facts; this module only carries them to the one door.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chapterLabel, type WriteMode } from '@book/shared';

import { chapterPath, readChapter } from '../engine/text.ts';
import type { SentencePatchEdit } from '../sentences/transform.ts';
import { sha256Hex } from '../util/hash.ts';
import type { EngineClient, LandView } from './client.ts';
import { PassRefusal, codeOf, reasonOf } from './reasons.ts';
import { restorePreSnapshot } from './revert.ts';

export type LaneIoDeps = {
  bookRoot: string;
  dataDir: string;
  chapter: number;
  leaseId: string;
  engine: EngineClient;
  log: (line: string) => void;
  /** The mode, edits and estimate as they stand **now** — read at the call, never captured early. */
  write: () => { mode: WriteMode | null; sentences: ReadonlyArray<SentencePatchEdit> | null; estimateUsd: number | null };
};

export type LaneIo = {
  writeText(value: string): void;
  preSnapshot(at: number): void;
  land(): Promise<LandView>;
};

export function createLaneIo(deps: LaneIoDeps): LaneIo {
  /** Atomic: a reader never sees half a chapter, and `land` reads a whole file. */
  function writeText(value: string): void {
    const target = chapterPath(deps.bookRoot, deps.chapter);
    const staging = `${target}.tmp`;
    writeFileSync(staging, value, 'utf8');
    renameSync(staging, target);
  }

  /** The pre-image, before the writer touches anything: what a revert puts back. */
  function preSnapshot(at: number): void {
    const dir = join(deps.dataDir, 'writer', 'pre');
    mkdirSync(dir, { recursive: true });
    const current = readChapter(deps.bookRoot, deps.chapter);
    const stamp = {
      chapter: deps.chapter,
      state: current.exists ? 'present' : 'absent',
      sha: current.exists ? sha256Hex(current.raw) : null,
      at,
    };
    if (current.exists) writeFileSync(join(dir, `ch${chapterLabel(deps.chapter)}.md`), current.raw, 'utf8');
    writeFileSync(join(dir, `ch${chapterLabel(deps.chapter)}.json`), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  }

  /** `land`: a `STEP_CLOSED` or `FRAME_CHANGED` answer takes the text back (BOOK-137). */
  async function land(): Promise<LandView> {
    const state = deps.write();
    try {
      return await deps.engine.land(deps.leaseId, {
        ...(state.sentences === null ? {} : { sentences: state.sentences }),
        ...(state.mode === null ? {} : { mode: state.mode }),
        ...(state.estimateUsd === null ? {} : { estimateUsd: state.estimateUsd }),
      });
    } catch (error) {
      const code = codeOf(error);
      const back =
        code === 'STEP_CLOSED' || code === 'FRAME_CHANGED' ? restorePreSnapshot(deps.dataDir, deps.bookRoot, deps.chapter) : null;
      if (back) deps.log(`[writer] land ${code ?? 'refused'}: снимок до прохода ${back.restored ? 'возвращён' : 'не найден'}`);
      throw new PassRefusal(reasonOf(error), codeOf(error));
    }
  }

  return { writeText, preSnapshot, land };
}
