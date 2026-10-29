/**
 * One writer pass, end to end (`docs/writer-lane.md` §1, §5–§6). The order:
 * ```
 * state → money guard (estimate vs the caps) → assignment → queued → start → prompt (rows)
 *   → read → belt (re-estimate) → model call(s) → tier 0 → land (the text travels) → gates
 *   (verdict ×2, one revision) → done (the close; it announces the landing) → landed (the stage)
 * ```
 *
 * Nothing is written until `land`, and the only thing written is a row (BOOK-187): the writer
 * holds the chapter in memory, sends it, and the engine publishes it. There is no manuscript file
 * and no pre-image to keep. A base that moved is answered by the writer at `start` (`relevance.ts`),
 * and every exit without `done` takes this pass's own landing back (`recovery.ts`, BOOK-219).
 *
 * A filing is **read before it is patched** (`passGuard.ts` `triageGuard`, BOOK-206/BOOK-173 §4):
 * a patch keys the reader's words to a verdict, so an unread filing is refused before the prompt is
 * bought. That refusal is the earlier, cheaper door; the engine's close (`VERDICTS_REQUIRED`) stays
 * the second one, and neither let text land without the verdict that admitted the filing.
 *
 * Everything the pass touches is injected — engine, transport, clock, log. It holds no database,
 * no socket, no key; the talking lives in `passLane.ts`, the prompts in `prompt.ts` / `gates.ts`,
 * the writing phase in `writePhase.ts`, the close in `closePass.ts`.
 *
 * A refusal the engine states (`CHAPTER_WRITTEN`, `PASS_LEASED`, `TOKENS_EXHAUSTED`) is returned,
 * never thrown. The bound this file enforces is money, not tokens: the estimate (`estimate.ts`)
 * is checked before the pass is opened and again, from the real prompt, before the first call.
 * Past the first landing a gate failure is auxiliary (owner, 2026-10-28) only when there is no
 * landing of our own to take back; BOOK-219's rule — no landed text without a verdict — is the
 * one this file keeps with `recovery.ts` and `closePass.ts`.
 */

import { isChapterNumber, type BudgetDto, type WriterAssignment } from '@book/shared';

import { isWrittenView } from '../engine/text.ts';
import { readBuildStamp } from '../buildStamp.ts';
import type { EngineClient, LandView } from './client.ts';
import { capLine, estimatePassUsd } from './estimate.ts';
import { moneyGuard, triageGuard } from './passGuard.ts';
import { createLane, assignmentData, type PassResult, type ProviderCall } from './passLane.ts';
import { buildWriterPrompt, chapterQuote, type BuiltPrompt } from './prompt.ts';
import { buildPatchPrompt, type PatchPrompt } from './patch/prompt.ts';
import { finalize } from './prose.ts';
import { chooseMode, RIPPLE_MODE, type ModeChoice, type ModeInput } from './mode.ts';
import { afterPatch } from './ripple/afterPatch.ts';
import { writeChapter } from './writePhase.ts';
import { dryRunPlan } from './dryRun.ts';
import { rightsRefusal } from './rightsGate.ts';
import { codeOf, failureOf, readerFallbacks, readerSentences, reasonOf, type Failure } from './reasons.ts';
import { NO_OP_LINE, stageSummary } from './stages.ts';
import { runGates } from './gatesPass.ts';
import { tier0Detail, tier0Of, verifyChange, type GatesRecord } from './verify/run.ts';
import type { Tier0Result } from './verify/tier0.ts';
import { closePass } from './closePass.ts';
import { backSentence } from './putBack.ts';
import { createRecovery } from './recovery.ts';
import { resumeBase, startWriting } from './relevance.ts';
import type { WriterConfig } from './config.ts';

export type { PassResult, PassStatus, ProviderCall } from './passLane.ts';

/**
 * BOOK-145: a step the engine already took away is not a failure of this pass — a step wall, a
 * released lease, a step closed by the engine. The lane says so in one line, asks `next` again at
 * once and never closes the dead step; a run that landed puts its own text back first (BOOK-219).
 */
const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type PassDeps = {
  config: WriterConfig;
  bookRoot: string;
  /** ADR-043 G3: the prompt bundle this image carries; absent reads the build stamp. */
  promptBundle?: string | null;
  engine: EngineClient;
  provider: ProviderCall;
  now: () => number;
  log: (line: string) => void;
  /** A dry run builds the plan and stops: no engine call, no model call, no write. */
  dryRun?: boolean;
  /** `--chapter N`: open that chapter's first pass instead of the lane's next slot. */
  chapter?: number | null;
  /** How to ask for work. `filing` is the door (BOOK-166); fwd/bwd stay for a direct walk. */
  lanes?: Array<'fwd' | 'bwd' | 'filing'>;
  /** BOOK-173 §7: this pass serves one ripple chapter — opened by the engine's ripple door. */
  ripple?: { chapter: number; changeId: string; reason: string; claim: string };
};

/** Run one pass. Returns a typed result and never throws. */
export async function runPass(deps: PassDeps): Promise<PassResult> {
  const { config, engine, bookRoot, now } = deps;

  if (deps.dryRun === true) {
    const chapter = deps.chapter ?? null;
    if (chapter === null) {
      return { status: 'refused', reason: 'dry-run нужен --chapter: слот полосы известен только после вызова движка' };
    }
    try {
      deps.log(`[writer] dry-run ${dryRunPlan({ bookRoot, chapter }).summary}: ничего не открыто, модель не звана, файлы не тронуты`);
      return { status: 'refused', reason: 'dry-run: проход не запускался' };
    } catch (error) {
      return { status: 'refused', reason: reasonOf(error) };
    }
  }

  // 1. The money guard (§6, BOOK-117): a pass that would cross a cap never asks for a job.
  const guard = await moneyGuard({ config, bookRoot, engine, log: deps.log });
  if (!guard.ok) return guard.result;
  const { budget, estimate } = guard;

  // 2. The assignment: a named chapter, a ripple chapter, or the lane's next slot.
  let picked: WriterAssignment | null;
  try {
    if (deps.ripple !== undefined) {
      picked = await engine.openRipple(deps.ripple.chapter, config.session, deps.ripple.changeId);
    } else if (deps.chapter !== null && deps.chapter !== undefined) {
      picked = await engine.pass(deps.chapter, config.session);
    } else {
      picked = null;
      // BOOK-166: work is asked for by filing, never by chapter order.
      for (const lane of deps.lanes ?? ['filing']) {
        picked = await engine.next(lane, config.session);
        if (picked !== null) break;
      }
    }
  } catch (error) {
    // A refusal before the lease is a fact about the day, not a parked pass.
    return { status: 'refused', reason: reasonOf(error) };
  }
  if (picked === null) return { status: 'idle', reason: 'пока нечего писать: заявок нет' };
  const filed = picked.changeId !== null && picked.changeId !== undefined
    ? true
    : (picked as { premise?: unknown }).premise !== null && (picked as { premise?: unknown }).premise !== undefined;
  // A resumed landed step continues at the gates (BOOK-117): it writes nothing.
  if (picked.pass === 'draft' && !filed && picked.landed !== true) {
    // A step without a filing is skipped, not spun on: ask the door once (BOOK-166).
    deps.log(`[writer] NO_FILING_FOR_CHAPTER: глава ${String(picked.chapter)} без заявки — пропускаю, спрашиваю дверь`);
    const filedAgain = await engine.next('filing', config.session);
    if (filedAgain === null || (filedAgain.pass === 'draft' && filedAgain.premise == null && filedAgain.changeId == null)) {
      return { status: 'idle', reason: 'пока нечего писать: заявок нет' };
    }
    picked = filedAgain;
  }

  const job: WriterAssignment = picked;
  if (typeof job.chapter !== 'number') {
    // A `front` step has no chapter, so there is nowhere to put a `refused` stage: the sentence stands.
    const reason = 'этот проход не про главу — его ведёт другая полоса, а не писатель';
    try {
      await engine.escalate(job.leaseId, reason);
    } catch (error) {
      deps.log(`[writer] escalate refused: ${reasonOf(error)}`);
    }
    return { status: 'parked', stepId: job.stepId, changeId: job.changeId, reason };
  }
  const chapter: number = job.chapter;
  // The engine's own per-role record: a role it already holds a verdict for is not asked again.
  const answered: Record<'editor' | 'consultant' | 'rights', boolean> = {
    editor: job.verdicts.editor,
    consultant: job.verdicts.consultant,
    rights: job.verdicts.rights === true,
  };
  const lane = createLane(
    {
      config,
      bookRoot,
      engine,
      provider: deps.provider,
      now,
      log: deps.log,
      promptBundle: deps.promptBundle === undefined ? readBuildStamp().promptBundleSha : deps.promptBundle,
    },
    job,
    chapter,
    answered,
  );
  // The estimate that let the pass open travels with it: the transcript is where money is proved.
  if (estimate !== null) lane.setEstimate(estimate);

  /** BOOK-219: the revision this run started from (or resumed at), and its sha. */
  let preRev: number | null = null;
  let preSha = '';
  let landedHere = false;
  /** The text as it now stands: the last revision this pass landed (or the resumed one). */
  let text = '';
  let beforeText = '';
  /** BOOK-DOC-80: Tier 0's verdict (before the write, for a patch) and the gates record. */
  let tier0: Tier0Result = { ok: true, findings: [], notes: [] };
  let gates: GatesRecord | null = null;
  const published = (): boolean => landedHere || lane.landedAt() !== null;

  /** BOOK-219: every exit without `done` takes this pass's own landing back first. */
  const recovery = createRecovery({
    engine,
    lane,
    job,
    chapter,
    state: { rev: () => preRev, sha: () => preSha, landed: published, text: () => text },
    log: deps.log,
  });

  function goneOf(code: string | null, detail: string): PassResult | null {
    if (code === null || !GONE_CODES.has(code)) return null;
    deps.log(`lease released by the engine — taking the next filing (${code}: ${detail.slice(0, 120)})`);
    return {
      status: 'gone',
      stepId: job.stepId,
      changeId: job.changeId,
      reason: 'lease released by the engine — taking the next filing',
    };
  }

  /**
   * BOOK-145 + BOOK-219: the wall that took the step away is why `gone` is right, but a run that
   * landed has already published, so the text goes back first — `gone` on its own is the answer
   * only when the way back finds nothing of ours (`none`), exactly as the rights path tells it.
   */
  async function goneAfterBack(code: string | null, detail: string): Promise<PassResult | null> {
    const answer = goneOf(code, detail);
    if (answer === null) return null;
    if (!published()) return answer;
    const back = await recovery.takeBack('шаг снят движком');
    if (back.kind === 'unverified') deps.log(`[writer] откат не подтверждён: ${back.detail}`);
    return answer;
  }

  try {
    // 3. `queued`: the engine opened the step — the writer is the one that says so.
    await lane.emit({
      stage: 'queued',
      chapter,
      passId: job.stepId,
      changeId: job.changeId,
      summary: stageSummary.queued({ chapter, pass: job.pass, premise: job.premise?.intent.value ?? null, intent: job.intent?.value ?? null }),
      model: null,
      at: now(),
    });

    // A resumed step already has its text on disk: the lane continues at the gates, not at the pen.
    const resume = job.landed === true;

    if (!resume) {
      // 4. `start`, then the pre-image — before a single byte of the chapter changes. A base the
      //    engine says has moved is answered by the writer here (`relevance.ts`), never parked.
      const opened = await startWriting({ engine, lane, job, chapter, log: deps.log });
      if (!opened.ok) {
        return (await goneAfterBack(opened.failure.code, opened.failure.detail)) ?? (await lane.park(opened.failure));
      }
      const started = opened.started;
      if (typeof started.sha !== 'string') return await lane.park({ detail: 'движок не зафиксировал исходный текст главы' });
      preRev = typeof started.expectedRev === 'number' ? started.expectedRev : null;
      preSha = started.sha;

      // 5. The mode (§4), the prompt, and the stage that says both were assembled. The rewrite
      //    prompt is built even in patch mode: the model may decline in one step.
      const modeInput: ModeInput = { pass: job.pass, scopeHint: job.scopeHint, sentenceAnchor: job.sentenceAnchor };
      let choice: ModeChoice;
      try {
        await lane.loadText([chapter - 1, chapter, chapter + 1]);
        // The same bytes a landing writes (one trailing newline), so a no-op compares equal.
        beforeText = finalize(chapterQuote(lane.textOf(chapter)));
        choice =
          deps.ripple === undefined
            ? chooseMode(modeInput, isWrittenView(lane.textOf(chapter)), config.modeDefault)
            : RIPPLE_MODE;
      } catch (error) {
        return await lane.park(failureOf(error));
      }
      // BOOK-206 + BOOK-173 §4: a patch is refused before it is written when the filing behind it
      // has not been read. It runs before the prompt is bought and long before the landing.
      const unread = triageGuard(job, choice.mode, deps.log);
      if (unread !== null) return unread;
      let built: BuiltPrompt, patchPrompt: PatchPrompt | null = null, rewrite: BuiltPrompt;
      try {
        const data = assignmentData(job);
        rewrite = buildWriterPrompt({ bookRoot, assignment: data, chapterText: lane.textOf });
        if (choice.mode === 'patch') {
          patchPrompt = buildPatchPrompt({ bookRoot, chapter, assignment: data, own: lane.textOf(chapter), ripple: deps.ripple ?? null });
        }
        built = patchPrompt ?? rewrite;
      } catch (error) {
        return await lane.park({ detail: `промпт не собран: ${error instanceof Error ? error.message : 'ошибка'}`.slice(0, 300) });
      }
      lane.setPrompt({ sections: built.sections, promptSha256: built.promptSha256, prefixSha256: built.prefixSha256 });
      lane.setMode(choice.mode, null);
      const neighbours = [chapter - 1, chapter + 1].filter(
        (n) => isChapterNumber(n) && isWrittenView(lane.textOf(n)),
      );
      await lane.emit({
        stage: 'read',
        chapter,
        passId: job.stepId,
        changeId: job.changeId,
        summary: stageSummary.read({
          sections: built.sections.length,
          chars: built.system.length + built.user.length,
          neighbours,
          mode: choice,
        }),
        model: null,
        at: now(),
      });

      // 6. The belt (§6): the real prompt can be larger than the pre-estimate and the ledger is
      //    shared, so price it again against the ledger as it is now and park this pass alone.
      if (budget !== null) {
        try {
          const fresh: BudgetDto | null = (await engine.state()).budget ?? null;
          if (fresh !== null) {
            const real = estimatePassUsd({
              pricing: config.pipeline.pricing,
              promptChars: built.system.length + built.user.length,
              continueMax: config.continueMax,
              mode: choice.mode,
              patchEdits: config.patchMaxEdits,
              reasoningAllowance: config.reasoningAllowance,
            });
            lane.setEstimate(real);
            const crossed = capLine(fresh, real.usd);
            if (crossed !== null) {
              deps.log(`[writer] ${crossed}`);
              return await lane.park({ detail: crossed });
            }
          }
        } catch (error) {
          // A failed re-read is not a licence to spend: the pre-estimate already passed.
          deps.log(`[writer] пересчёт оценки не выполнен: ${reasonOf(error)}`);
        }
      }

      // 7. The writing phase (`writePhase.ts`): patch or rewrite, one session, one attempt.
      const written = await writeChapter({
        lane,
        bookRoot,
        chapter,
        mode: choice,
        rewrite,
        patch: patchPrompt,
        chapterText: lane.textOf,
        continueMax: config.continueMax,
        patchMaxFraction: config.patchMaxFraction,
        patchMaxEdits: config.patchMaxEdits,
        log: deps.log,
      });
      if (!written.ok) {
        lane.setMode(written.mode, written.patch);
        return await lane.park({
          code: written.code,
          detail: written.detail,
          fallback: readerFallbacks.gate,
          cause: written.cause,
        });
      }
      text = written.text;
      // BOOK-173 §2: the patch's character edits travel to `land`, which is what keeps ids.
      lane.setMode(written.mode, written.patch, written.sentences);

      // 7b. BOOK-DOC-80, Tier 0 — the countable invariants, **before** a byte is written.
      if (lane.mode() === 'patch') {
        tier0 = tier0Of({ bookRoot, chapter, before: beforeText, after: text });
        if (!tier0.ok) {
          deps.log(`[writer] tier 0 отказал: ${tier0Detail(tier0)}`);
          return await lane.park({ code: 'TIER0_FAILED', detail: tier0Detail(tier0), fallback: readerFallbacks.gate });
        }
      }

      // 8. The landing that makes the answer a revision — the text travels, no file is touched.
      let landing: LandView | null;
      try {
        landing = await lane.land(text);
        landedHere = true;
      } catch (error) {
        return (await goneAfterBack(codeOf(error), reasonOf(error))) ?? (await lane.park(failureOf(error)));
      }
      // BOOK-173 §5: the silent no-op, said out loud — a pass that moved no byte must not read
      // in the log like a landing.
      if (lane.mode() === 'rewrite' && text === beforeText) deps.log(`[writer] ${NO_OP_LINE}, глава ${String(chapter)}`);
      const reaction = await afterPatch({ plan: landing?.plan ?? null, chapter, job, lane, bookRoot, now, log: deps.log });
      // A ripple park is the design's own verdict (a `wide`, a refusal the author decides), and its
      // sentence says the point patch stays: the text is not taken back behind that sentence.
      if (reaction.kind === 'park') return await lane.park({ detail: reaction.sentence, ...(reaction.cause === undefined ? {} : { cause: reaction.cause }) });

      // 8b. BOOK-DOC-80: Tier 1 and the table decide whether the full pair is still needed.
      const verified = await verifyChange({
        config,
        bookRoot,
        chapter,
        before: beforeText,
        after: text,
        plan: landing?.plan ?? null,
        mode: lane.mode(),
        tier0,
        lane,
        log: deps.log,
      });
      gates = verified.record;
      lane.setGates(gates);

      // A landing drops the verdicts of the previous revision: every gate is asked again.
      answered.editor = false;
      answered.consultant = false;
      answered.rights = false;
    } else {
      // A resumed step: the rows hold the landed text the gates may ask for below, and the base
      // its own re-landing returns to is the revision the step stands at (`resumeBase`, BOOK-219).
      const base = await resumeBase({ engine, job, chapter, log: deps.log });
      preRev = base.rev;
      preSha = base.sha;
      try {
        await lane.loadText([chapter]);
      } catch (error) {
        return await lane.park(failureOf(error));
      }
      if (!lane.textOf(chapter).exists) {
        return await lane.park({ detail: 'текста главы нет в базе — проход не возобновить' });
      }
      text = finalize(chapterQuote(lane.textOf(chapter)));
      beforeText = text;
    }

    // 9. The gates (`gatesPass.ts`, BOOK-DOC-80): the full pair only on a trigger, Gate B always.
    //    A `local only` change closes on the local judge's word; a resumed step has no verification
    //    record, so it takes the pair exactly as it always did.
    const gateOutcome = await runGates({
      lane,
      log: deps.log,
      full: gates === null || gates.gatesMode !== 'local only',
      answered,
    });
    if (gateOutcome.kind === 'rights') {
      // The rights gate refused the text and the engine closed the step: no `done`, no revision.
      // The refused text is live, so it is taken back first, and the sentence says which happened.
      deps.log('[writer] права: отказ — шаг закрыт движком, проход завершён');
      const back = await recovery.takeBack('права отказали');
      const refused = rightsRefusal({
        stepId: job.stepId,
        changeId: job.changeId,
        lane,
        config,
        sentence: backSentence(back, 'rights') ?? readerSentences.rightsUnverified,
      });
      await lane.transcript(refused);
      return refused;
    }
    // A revision this pass landed is part of its own text: the way back and the close read *it*.
    if (gateOutcome.revised !== undefined) text = gateOutcome.revised;
    if (gateOutcome.kind === 'park') {
      const stepped = await goneAfterBack(gateOutcome.failure.code ?? null, gateOutcome.failure.detail);
      if (stepped !== null) return stepped;
      // A rights failure (or an unreadable gate answer, or a revision that never validated) is not
      // auxiliary: the text it landed has no verdict, so it goes back before the pass parks.
      const code = gateOutcome.failure.code ?? '';
      const back = await recovery.takeBack(code === '' ? 'правка не прошла проверку' : 'гейт не ответил');
      return await recovery.parkAfter(
        { ...gateOutcome.failure, fallback: gateOutcome.fallback },
        back,
        code.startsWith('RIGHTS') ? 'rights' : 'gate',
      );
    }
    const survived: Failure | null = gateOutcome.survived;
    if (survived !== null) {
      lane.remember(survived);
      deps.log(`[writer] гейт не ответил (${survived.code ?? 'без кода'}): ${survived.detail}`);
      // BOOK-219, the compensating revert: a pass that published and then lost its verdict takes
      // its own landing back before it parks — the engine requires `landed_at` to dispatch a gate.
      const back = await recovery.takeBack('гейт не ответил');
      if (back.kind !== 'none') return await recovery.parkAfter({ ...survived, cause: 'failed' }, back);
      // `none`: this run published nothing (a resumed step that only read the gates).
      deps.log('[writer] откат не нужен: текст опубликован не этим проходом — шаг закрывается');
    }

    // 10–11. `landed`, then `done`: the close is its own seam (`closePass.ts`) — the money it
    //     reports and the words it closes with are BOOK-219's business too.
    return await closePass({
      lane,
      engine,
      config,
      chapter,
      job,
      text,
      beforeText,
      failed: survived,
      started: { rev: preRev, sha: preSha },
      landing: lane.landedAt(),
      landed: published(),
      mode: lane.mode(),
      gates,
      log: deps.log,
      now,
    });
  } catch (error) {
    const stepped = await goneAfterBack(codeOf(error), reasonOf(error));
    if (stepped !== null) return stepped;
    // BOOK-219's invariant covers a thrown failure too: after our own landing the text goes back
    // before the pass parks, or a reader keeps a revision a broken pass published.
    const back = await recovery.takeBack('проход сломался');
    if (back.kind !== 'none') return await recovery.parkAfter(failureOf(error), back);
    return await lane.park(failureOf(error));
  }
}
