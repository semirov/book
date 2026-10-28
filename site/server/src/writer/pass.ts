/**
 * One writer pass, end to end (`docs/writer-lane.md` §1, §5–§6).
 *
 * ```
 * state → money guard (estimate vs the caps) → assignment → queued → start → pre-snapshot
 *   → prompt → read → belt (re-estimate the real prompt) → model call(s) → validate (one retry
 *   with the reason) → continuation calls → atomic write → land → gates (verdict ×2, at most one
 *   revision cycle) → landed → done
 * ```
 *
 * Everything the pass touches is injected: the engine client, the model transport, the clock and
 * the logger. The pass holds no database, no socket and no key of its own; the talking lives in
 * `passLane.ts`, the prompts and the answer contracts in `prompt.ts` / `gates.ts`.
 *
 * A refusal the engine states (`CHAPTER_WRITTEN`, `PASS_LEASED`, `TOKENS_EXHAUSTED`) is returned,
 * never thrown. The bound this file enforces is money, not tokens: the estimate (`estimate.ts`)
 * is checked before the pass is opened and again, from the real prompt, before the first call.
 * A failure after the lease parks the pass — `escalate` with one plain sentence plus a `refused`
 * stage carrying it, never silently dropped. Past the first landing a failure is auxiliary
 * instead (owner, 2026-10-28): a stage, a transcript or an engine transport that fails is logged
 * and remembered, never escalated over text that landed; the close is the fact that must land.
 *
 * `landed` carries the pass's whole money line (writer calls and gate calls); `done` carries the
 * writer's own tokens only, because the engine adds each gate's from its verdict rows.
 */

import { readFileSync } from 'node:fs';

import { isChapterNumber, type BudgetDto, type WriterAssignment } from '@book/shared';

import { chapterPath, isWrittenChapter, readChapter } from '../engine/text.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import type { DoneView, EngineClient, EngineStateView, LandView, StartView } from './client.ts';
import { capLine, estimateLine, estimatePassUsd, type PassEstimate } from './estimate.ts';
import { createLane, assignmentData, type GateRun, type PassResult, type ProviderCall } from './passLane.ts';
import { costUsd } from './pipeline.ts';
import { buildWriterPrompt, type BuiltPrompt } from './prompt.ts';
import { buildPatchPrompt, type PatchPrompt } from './patch/prompt.ts';
import { chooseMode, RIPPLE_MODE, type ModeChoice } from './mode.ts';
import { afterPatch } from './ripple/afterPatch.ts';
import { writeChapter } from './writePhase.ts';
import { dryRunPlan } from './dryRun.ts';
import { rightsRefusal } from './rightsGate.ts';
import { codeOf, failureOf, isTransportFailure, readerFallbacks, reasonOf, type Failure } from './reasons.ts';
import { changedSpans } from './span.ts';
import { stageSummary } from './stages.ts';
import type { WriterConfig } from './config.ts';

export type { PassResult, PassStatus, ProviderCall } from './passLane.ts';

/** One gate's revision in a pass, whatever the engine's cycle cap allows. */
const MAX_REVISIONS = 1;

/**
 * BOOK-145: a step the engine already took away is not a failure of this pass.
 *
 * A step wall, a released lease, a step the engine closed itself: the text may be landed and the
 * step is simply not ours any more. The lane says so in one line, asks `next` again immediately
 * and never tries to close the dead step — a park there would be a second, false story.
 */
const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type PassDeps = {
  config: WriterConfig;
  bookRoot: string;
  dataDir: string;
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
  /** BOOK-173 §7: this pass serves one chapter of a ripple — opened by the engine's ripple door. */
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
  let state: EngineStateView;
  try {
    state = await engine.state();
  } catch (error) {
    return { status: 'refused', reason: reasonOf(error) };
  }
  // Tokens are information, not a bound (2026-10-27): the $ cap is, so `tokens.today` is unread.
  const budget: BudgetDto | null = state.budget ?? null;
  let estimate: PassEstimate | null = null;
  if (budget === null) {
    // An engine from before the cap reports no money: say so — a silent pretend-bound is worse.
    deps.log('[writer] бюджет недоступен: движок не отдаёт потолки — проход идёт без денежной проверки');
  } else if (budget.state === 'stop' || budget.state === 'pause') {
    deps.log(`[writer] idle ${budget.line}`);
    return { status: 'idle', reason: budget.line };
  } else {
    // The estimate precedes the assignment: a pass that would not fit is never opened.
    let priced: PassEstimate;
    try {
      priced = estimatePassUsd({ pricing: config.pipeline.pricing, bookRoot, continueMax: config.continueMax });
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : 'оценка прохода не собрана' };
    }
    estimate = priced;
    deps.log(estimateLine(priced, budget));
    const crossed = capLine(budget, priced.usd);
    if (crossed !== null) {
      deps.log(`[writer] idle ${crossed}`);
      return { status: 'idle', reason: crossed };
    }
  }

  // 2. The assignment: a named chapter, or the lane's next slot.
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
  const answered = { ...job.verdicts };
  const lane = createLane(
    { config, bookRoot, dataDir: deps.dataDir, engine, provider: deps.provider, now, log: deps.log },
    job,
    chapter,
    answered,
  );
  // The estimate that let the pass open travels with it: the transcript is where money is proved.
  if (estimate !== null) lane.setEstimate(estimate);
  let beforeText = '';

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

  /** The same check for a thrown engine refusal. */
  function gone(error: unknown): PassResult | null {
    return goneOf(codeOf(error), reasonOf(error));
  }

  /** One gate round: the editor, then the consultant when the editor asks for no revision. */
  async function gateRound(refusal?: string | null): Promise<
    | { ok: true; editor: GateRun; consultant: GateRun | null; rightsClosed: boolean }
    | { ok: false; failure: Failure }
  > {
    try {
      const editor = await lane.runGate('editor', refusal ?? null);
      const consultant = editor.revise ? null : await lane.runGate('consultant', refusal ?? null);
      // BOOK-61: Gate B last, and it may close the step itself — a refusal is a decision about
      // the text, so there is nothing left for this pass to finish.
      const rights = await lane.runRightsGate();
      return { ok: true, editor, consultant, rightsClosed: rights.closed };
    } catch (error) {
      return { ok: false, failure: failureOf(error) };
    }
  }

  try {
    // 3. `queued`: the engine opened the step; the writer is the one that says so.
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
    let text = '';
    // What the writing phase needs from above: the mode and the rewrite prompt it falls back to.
    let choice: ModeChoice = chooseMode({ pass: job.pass, scopeHint: job.scopeHint }, false);
    let rewritePrompt: BuiltPrompt | null = null;

    if (!resume) {
      // 4. `start`, then the pre-image — before a single byte of the chapter changes.
      let started: StartView;
      try {
        started = await engine.start(job.leaseId);
      } catch (error) {
        return gone(error) ?? (await lane.park(failureOf(error)));
      }
      if (typeof started.sha !== 'string') return await lane.park({ detail: 'движок не зафиксировал исходный текст главы' });
      try {
        lane.preSnapshot(now());
      } catch {
        return await lane.park({ detail: 'не удалось сохранить снимок главы перед проходом' });
      }
      beforeText = readChapter(bookRoot, chapter).exists ? readFileSync(chapterPath(bookRoot, chapter), 'utf8') : '';

      // 5. The mode (§4), the prompt, and the stage that says both were assembled.
      //    The rewrite prompt is built even in patch mode: the model may decline in one step.
      const own = readChapter(bookRoot, chapter);
      choice = deps.ripple === undefined ? chooseMode({ pass: job.pass, scopeHint: job.scopeHint }, isWrittenChapter(own)) : RIPPLE_MODE;
      let built: BuiltPrompt;
      let patchPrompt: PatchPrompt | null = null;
      try {
        const data = assignmentData(job);
        rewritePrompt = buildWriterPrompt({ bookRoot, assignment: data });
        if (choice.mode === 'patch') patchPrompt = buildPatchPrompt({ bookRoot, chapter, assignment: data, ripple: deps.ripple ?? null });
        built = patchPrompt ?? rewritePrompt;
      } catch (error) {
        return await lane.park({ detail: `промпт не собран: ${error instanceof Error ? error.message : 'ошибка'}`.slice(0, 300) });
      }
      lane.setPrompt(built.sections.length, built.promptSha256, built.prefixSha256);
      lane.setMode(choice.mode, null);
      const neighbours = [chapter - 1, chapter + 1].filter(
        (n) => isChapterNumber(n) && isWrittenChapter(readChapter(bookRoot, n)),
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
          // A failed re-read is not a licence to spend: the pre-estimate already passed, and the
          // engine refuses the next call of a pass it will not hand out.
          deps.log(`[writer] пересчёт оценки не выполнен: ${reasonOf(error)}`);
        }
      }

      // 7. The writing phase (`writePhase.ts`): patch or rewrite, one session, one attempt.
      //    Only the model's own refusal of the work refuses the premise; a failed call, a cut
      //    answer or a broken patch is a pass that broke.
      const written = await writeChapter({
        lane,
        bookRoot,
        chapter,
        mode: choice,
        rewrite: rewritePrompt as BuiltPrompt,
        patch: patchPrompt,
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
      lane.setMode(written.mode, written.patch);

      // 8. The write, and the landing that makes it a revision.
      try {
        lane.writeText(text);
      } catch {
        return await lane.park({ detail: 'не удалось записать главу' });
      }
      let landing: LandView;
      try {
        landing = await lane.land();
      } catch (error) {
        return gone(error) ?? (await lane.park(failureOf(error)));
      }
      const reaction = await afterPatch({ plan: landing.plan ?? null, chapter, job, lane, bookRoot, now, log: deps.log });
      if (reaction.kind === 'park') return await lane.park({ detail: reaction.sentence, ...(reaction.cause === undefined ? {} : { cause: reaction.cause }) });
      // A landing drops the verdicts of the previous revision: every gate is asked again.
      answered.editor = false;
      answered.consultant = false;
      answered.rights = false;
    } else {
      // A resumed step: this file is the pre-image of a revision the gates may ask for below.
      if (!readChapter(bookRoot, chapter).exists) {
        return await lane.park({ detail: 'текста главы нет на диске — проход не возобновить' });
      }
      text = readFileSync(chapterPath(bookRoot, chapter), 'utf8');
      beforeText = text;
      lane.preSnapshot(now());
    }

    // 9. The gates: editor, then consultant; at most one revision cycle for the whole pass.
    //    Past the first landing these are *auxiliary*: a failure is remembered and `done` still runs.
    let revisions = 0;
    let failed: Failure | null = null;
    for (;;) {
      let round = await gateRound();
      // A transport failure and a refused answer both get one retry; the parse failure carries
      // its own reason back to the model, so the second answer can be the one that parses.
      if (!round.ok && (isTransportFailure(round.failure) || round.failure.code === 'GATE_UNPARSED')) {
        deps.log(`[writer] гейт не спрошен (${round.failure.code ?? 'транспорт'}): ${round.failure.detail.slice(0, 200)} — повтор`);
        round = await gateRound(round.failure.detail);
      }
      if (!round.ok) {
        const stepped = goneOf(round.failure.code ?? null, round.failure.detail);
        if (stepped !== null) return stepped;
        // A rights failure is not auxiliary: the step cannot close without an answer, so the
        // pass stops here with a sentence instead of walking into `RIGHTS_REQUIRED`.
        const code = round.failure.code ?? '';
        if (code.startsWith('RIGHTS') || code === 'GATE_UNPARSED') {
          return await lane.park({ ...round.failure, fallback: readerFallbacks.gate });
        }
        failed = round.failure;
        break;
      }
      const { editor, consultant, rightsClosed } = round;
      if (rightsClosed) {
        // The rights gate refused the text and the engine closed the step: no `done`, no revision.
        deps.log('[writer] права: отказ — шаг закрыт движком, проход завершён');
        return rightsRefusal({ stepId: job.stepId, changeId: job.changeId, lane, config });
      }
      if (!editor.revise && consultant?.revise !== true) break;
      if (revisions >= MAX_REVISIONS) break;
      revisions += 1;
      const revised = await lane.reviseText([...editor.findings, ...(consultant?.findings ?? [])]);
      if (revised === null) {
        return await lane.park({ detail: 'правка после замечаний гейта не прошла проверку' });
      }
      text = revised;
      answered.editor = false;
      answered.consultant = false;
      answered.rights = false;
    }
    if (failed !== null) {
      // Remembered, not fatal: the transcript is where a survived failure is proved.
      deps.log(`[writer] гейт не ответил (${failed.code ?? 'без кода'}): ${failed.detail} — шаг закрывается`);
      lane.remember(failed);
    }

    // 10. `landed`: the span, the tokens, the money — a stage, so it can never throw.
    const usage = lane.usage();
    const passCost = costUsd(config.pipeline.pricing, usage);
    const parsed = parseChapter(chapter, text);
    await lane.emit({
      stage: 'landed',
      chapter,
      passId: job.stepId,
      changeId: job.changeId,
      summary: stageSummary.landed({
        chapter,
        chars: parsed.chars,
        blocks: parsed.blocks.length,
        tokensIn: usage.in,
        tokensOut: usage.out,
        tokensCachedIn: usage.cachedIn,
        costUsd: passCost,
      }),
      model: config.model,
      span: changedSpans(beforeText, text, chapter),
      tokens: { in: usage.in, out: usage.out },
      costUsd: passCost,
      at: now(),
    });

    // 11. `done`: the writer's tokens only (the engine adds each gate's). A landed step closes on
    //     what it has: `STEP_CLOSED` is that close, a transport failure gets one more try.
    let closed: DoneView | null = null;
    let closeFailure: Failure | null = null;
    for (let attempt = 0; attempt < 2 && closed === null; attempt += 1) {
      try {
        closed = await engine.done({
          leaseId: job.leaseId,
          note: `глава ${String(chapter)}: ${String(parsed.chars)} знаков, ${String(parsed.blocks.length)} абзацев`,
          model: config.model,
          tokensIn: lane.writerTokens().in,
          tokensOut: lane.writerTokens().out,
          seams: [],
        });
      } catch (error) {
        closeFailure = failureOf(error);
        // The step is closed either way; `done` on it is a no-op, and the pass says what it did.
        if (closeFailure.code === 'STEP_CLOSED') {
          closed = { stepId: job.stepId, outcome: 'already-closed', cascadeId: null, changeStatus: null };
          break;
        }
        if (!isTransportFailure(closeFailure) || attempt > 0) break;
        deps.log(`[writer] done не прошёл (${closeFailure.code ?? 'транспорт'}): ${closeFailure.detail} — повтор`);
      }
    }
    if (closed === null) {
      // The gate's own failure is why the verdicts never arrived; the close's refusal is its own.
      const why: Failure =
        closeFailure?.code === 'VERDICTS_REQUIRED' && failed !== null
          ? failed
          : (closeFailure ?? failed ?? { code: null, detail: 'шаг не закрылся: движок не подтвердил закрытие' });
      return await lane.park({ ...why, fallback: why === failed ? readerFallbacks.gate : readerFallbacks.stopped });
    }

    const result: PassResult = {
      status: 'closed',
      stepId: closed.stepId,
      changeId: job.changeId,
      tokens: lane.writerTokens(),
      costUsd: passCost,
    };
    lane.transcript(result);
    deps.log(
      `[writer] closed ${closed.stepId}: ${closed.outcome}, глава ${String(chapter)}, ${String(parsed.chars)} знаков, $${passCost.toFixed(4)}`,
    );
    return result;
  } catch (error) {
    const stepped = gone(error);
    if (stepped !== null) return stepped;
    const parked = await lane.park(failureOf(error));
    lane.transcript(parked);
    return parked;
  }
}
