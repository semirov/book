/**
 * The premise branch of the claim path (BOOK-7, BOOK-235).
 *
 * A premise waits for its chapter's first pass, never for the FIFO lane — and it must never stall
 * the change behind it (BOOK-7's own words). `startDraft` answers `null` for a premise it cannot
 * serve: a chapter somebody has already written (a written chapter changes through the lane), a
 * draft already in flight, no capacity, a paused day. That null used to end the whole poll: the
 * head of the lane was never asked, the premise stayed queued until the next boot and the writer
 * printed «пока нечего писать: заявок нет» for hours — the prod shape of BOOK-235.
 *
 * So this module does the two things the claim path owes when no draft was handed out: it names
 * every skipped premise (ids and conditions only), and it ends the ones the engine already knows
 * how to end — through `reconcilePremises`, never a second copy of its rule. A paused day is a
 * wait: it is named, spends no attempt, hands nothing out, and the caller stops there.
 */

import { reconcilePremises } from './premise.ts';
import type { QueueLog } from './queueBlock.ts';
import * as store from './store.ts';
import { isBasisSlot, isWrittenChapter, readChapterRows } from './text.ts';
import { premiseSettledCondition } from './zombieSweep.ts';
import type { EngineDeps } from './types.ts';

export type PremiseBranchDeps = {
  deps: EngineDeps;
  log: QueueLog;
  /** The day's money bound: it throws `BUDGET_PAUSED`/`BUDGET_STOPPED` instead of returning. */
  budgetGuard: (at: number) => void;
};

export type PremiseBranch = {
  /**
   * Name the premises the draft lane refused, settle the dead ones, and say whether the poll must
   * stop here (a paused or stopped day: nothing counted, nothing handed out).
   */
  settleSkipped: (at: number) => boolean;
};

export function createPremiseBranch(input: PremiseBranchDeps): PremiseBranch {
  const { deps, log, budgetGuard } = input;
  const { db } = deps;

  /** Why one queued premise cannot be opened, in the engine's own words — `null` when it can. */
  function blockerOf(filing: store.ChangeRow): string | null {
    const slot = readChapterRows(db, filing.chapter);
    if (slot.exists && isBasisSlot(slot)) return 'basis-only';
    // A written chapter changes through the FIFO lane (`claimHead`), not through a draft.
    if (isWrittenChapter(slot)) return 'chapter-written';
    if (store.listOpenSteps(db).some((step) => step.pass === 'draft' && step.chapter === filing.chapter)) {
      return 'draft-in-flight';
    }
    return null;
  }

  /** A paused day is a wait, not a refusal: it spends no attempt and hands nothing out. */
  function budgetWait(at: number): string | null {
    try {
      budgetGuard(at);
      return null;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as { code: string }).code : null;
      if (code === 'BUDGET_PAUSED') return 'budget-paused';
      if (code === 'BUDGET_STOPPED') return 'budget-stopped';
      throw error;
    }
  }

  function settleSkipped(at: number): boolean {
    const skipped = store.listPending(db).filter((filing) => filing.premise === 1);
    if (skipped.length === 0) return false;
    const wait = budgetWait(at);
    log.report(
      skipped.map((filing) => {
        // `no-capacity` is the honest catch-all: `startDraft` answers one `null` for a cap, for a
        // chapter whose draft is already open and for anything else it refused without a word, so
        // the row is named by what the poll knows, never by a guess at a reason it never said.
        const blocker = blockerOf(filing) ?? wait ?? 'no-capacity';
        return `queue: filing ${filing.id} (chapter ${String(filing.chapter)}) cannot be opened — ${blocker}`;
      }),
    );
    // BOOK-7's own rule, never a second copy of it: a premise whose chapter was written without
    // it, or whose slot is the frozen frame, can never be drafted again — it is closed here with
    // its public reason instead of waiting for the next boot.
    for (const id of reconcilePremises(deps, at)) {
      log.report([`queue: filing ${id} settled — ${premiseSettledCondition(db, id)}`]);
    }
    return wait !== null;
  }

  return { settleSkipped };
}
