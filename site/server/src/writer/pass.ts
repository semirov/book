/**
 * One writer pass, end to end (`docs/writer-lane.md` §1, §5–§6). The order:
 * ```
 * state → money guard (estimate vs the caps) → assignment → queued → start → prompt (rows)
 *   → read → belt (re-estimate) → model call(s) → validate (one retry with the reason)
 *   → continuation calls → land (the text travels in the request) → gates (verdict ×2, one
 *   revision) → landed → done
 * ```
 *
 * Nothing is written until `land`, and the only thing written is a row (BOOK-187): the writer
 * holds the chapter in memory, sends it, and the engine publishes it. There is no manuscript file
 * and no pre-image to keep.
 *
 * Everything the pass touches is injected — engine, transport, clock, log. It holds no database,
 * no socket, no key; the talking lives in `passLane.ts`, the prompts in `prompt.ts` / `gates.ts`.
 *
 * A refusal the engine states (`CHAPTER_WRITTEN`, `PASS_LEASED`, `TOKENS_EXHAUSTED`) is returned,
 * never thrown. The bound this file enforces is money, not tokens: the estimate (`estimate.ts`)
 * is checked before the pass is opened and again, from the real prompt, before the first call.
 * A failure after the lease parks the pass — `escalate` with one sentence, never silently dropped.
 * Past the first landing a failure is auxiliary (owner, 2026-10-28): logged and remembered, never
 * escalated over text that landed; the close is the fact that must land.
 *
 * `landed` carries the pass's money line (writer + gate calls); `done` the writer's tokens only.
 */

import { isChapterNumber, type BudgetDto, type WriteMode, type WriterAssignment } from '@book/shared';

import { isWrittenView } from '../engine/text.ts';
import { readBuildStamp } from '../buildStamp.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import type { EngineClient, LandView, StartView } from './client.ts';
import { capLine, estimatePassUsd } from './estimate.ts';
import { moneyGuard } from './passGuard.ts';
import { createLane, assignmentData, type PassResult, type ProviderCall } from './passLane.ts';
import { costUsd } from './pipeline.ts';
import { buildWriterPrompt, chapterQuote, type BuiltPrompt } from './prompt.ts';
import { buildPatchPrompt, type PatchPrompt } from './patch/prompt.ts';
import { finalize } from './prose.ts';
import { chooseMode, RIPPLE_MODE, type ModeChoice, type ModeInput } from './mode.ts';
import { afterPatch } from './ripple/afterPatch.ts';
import { writeChapter } from './writePhase.ts';
import { dryRunPlan } from './dryRun.ts';
import { rightsRefusal } from './rightsGate.ts';
import { codeOf, failureOf, readerFallbacks, reasonOf, type Failure } from './reasons.ts';
import { changedSpans } from './span.ts';
import { NO_OP_LINE, stageSummary } from './stages.ts';
import { closeTick } from './closeTick.ts';
import { runGates } from './gatesPass.ts';
import { tier0Detail, tier0Of, verifyChange, type GatesRecord } from './verify/run.ts';
import type { Tier0Result } from './verify/tier0.ts';
import type { WriterConfig } from './config.ts';

export type { PassResult, PassStatus, ProviderCall } from './passLane.ts';

/**
 * BOOK-145: a step the engine already took away is not a failure of this pass — a step wall, a
 * released lease, a step closed under us. One line, `next` again, and never a park on a dead step.
 */
const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type PassDeps = {
  config: WriterConfig;
  bookRoot: string;
  dataDir: string;
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
    let text = '';
    /** BOOK-DOC-80: Tier 0's verdict (always run before the write) and the gates record. */
    let tier0: Tier0Result = { ok: true, findings: [], notes: [] };
    let gates: GatesRecord | null = null;
    // What the writing phase needs from above: the mode and the rewrite prompt it falls back to.
    const modeInput: ModeInput = { pass: job.pass, scopeHint: job.scopeHint, sentenceAnchor: job.sentenceAnchor };
    let choice: ModeChoice = chooseMode(modeInput, false);
    let rewritePrompt: BuiltPrompt | null = null;

    if (!resume) {
      // 4. `start`, then the pre-image.
      let started: StartView;
      try {
        started = await engine.start(job.leaseId);
      } catch (error) {
        return gone(error) ?? (await lane.park(failureOf(error)));
      }
      if (typeof started.sha !== 'string') return await lane.park({ detail: 'движок не зафиксировал исходный текст главы' });
      // The pre-image is the rows themselves (BOOK-187): nothing has been touched yet, so a
      // refusal leaves the chapter exactly as the site serves it. The text a prompt quotes is read
      // from the engine in one call — the target and its two neighbours.
      try {
        await lane.loadText([chapter - 1, chapter, chapter + 1]);
        // The same bytes a landing writes (one trailing newline), so a no-op compares equal and
        // Tier 0 sees the edit rather than a lost newline.
        beforeText = finalize(chapterQuote(lane.textOf(chapter)));
      } catch (error) {
        return await lane.park(failureOf(error));
      }

      // 5. The mode (§4), the prompt, and the stage that says both were assembled.
      //    The rewrite prompt is built even in patch mode: the model may decline in one step.
      // `WRITER_MODE_DEFAULT=rewrite` forces the whole-chapter path for every ordinary pass; a
      // ripple chapter keeps its own mode (a rewrite there is what the ripple is not).
      choice =
        deps.ripple === undefined
          ? chooseMode(modeInput, isWrittenView(lane.textOf(chapter)), config.modeDefault)
          : RIPPLE_MODE;
      let built: BuiltPrompt;
      let patchPrompt: PatchPrompt | null = null;
      try {
        const data = assignmentData(job);
        rewritePrompt = buildWriterPrompt({ bookRoot, assignment: data, chapterText: lane.textOf });
        if (choice.mode === 'patch') {
          patchPrompt = buildPatchPrompt({
            bookRoot,
            chapter,
            assignment: data,
            own: lane.textOf(chapter),
            ripple: deps.ripple ?? null,
          });
        }
        built = patchPrompt ?? rewritePrompt;
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
          // A failed re-read is not a licence to spend: the pre-estimate already passed, and the
          // engine refuses the next call of a pass it will not hand out.
          deps.log(`[writer] пересчёт оценки не выполнен: ${reasonOf(error)}`);
        }
      }

      // 7. The writing phase (`writePhase.ts`): patch or rewrite, one session, one attempt. Only
      //    the model's own refusal refuses the premise; a broken patch is a pass that broke.
      const written = await writeChapter({
        lane,
        bookRoot,
        chapter,
        mode: choice,
        rewrite: rewritePrompt as BuiltPrompt,
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
      // BOOK-173 §2: the patch's characters edits travel to `land`, which is what keeps ids.
      lane.setMode(written.mode, written.patch, written.sentences);

      // 7b. BOOK-DOC-80, Tier 0 — the countable invariants, **before** a byte is written. Only a
      //     patch names a span; a rewrite is judged by the pair, which it always takes.
      if (lane.mode() === 'patch') {
        tier0 = tier0Of({ bookRoot, chapter, before: beforeText, after: text });
        if (!tier0.ok) {
          deps.log(`[writer] tier 0 отказал: ${tier0Detail(tier0)}`);
          return await lane.park({ code: 'TIER0_FAILED', detail: tier0Detail(tier0), fallback: readerFallbacks.gate });
        }
      }

      // 8. The landing that makes the answer a revision — the text travels, no file is touched.
      let landing: LandView;
      try {
        landing = await lane.land(text);
      } catch (error) {
        return gone(error) ?? (await lane.park(failureOf(error)));
      }
      // BOOK-173 §5: the silent no-op, said out loud — a pass that moved no byte must not read
      // in the log like a landing.
      if (lane.mode() === 'rewrite' && text === beforeText) deps.log(`[writer] ${NO_OP_LINE}, глава ${String(chapter)}`);
      const reaction = await afterPatch({ plan: landing.plan ?? null, chapter, job, lane, bookRoot, now, log: deps.log });
      if (reaction.kind === 'park') return await lane.park({ detail: reaction.sentence, ...(reaction.cause === undefined ? {} : { cause: reaction.cause }) });

      // 8b. BOOK-DOC-80: Tier 1 and the table decide whether the full pair is still needed. A
      //     `GAP` here goes to the pair — the judge of the judge — never to the reader.
      const verified = await verifyChange({
        config,
        bookRoot,
        chapter,
        before: beforeText,
        after: text,
        plan: landing.plan ?? null,
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
      // A resumed step: the rows hold the landed text the gates may ask for below.
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
      deps.log('[writer] права: отказ — шаг закрыт движком, проход завершён');
      return rightsRefusal({ stepId: job.stepId, changeId: job.changeId, lane, config });
    }
    if (gateOutcome.kind === 'park') {
      const stepped = goneOf(gateOutcome.failure.code ?? null, gateOutcome.failure.detail);
      if (stepped !== null) return stepped;
      return await lane.park({ ...gateOutcome.failure, fallback: gateOutcome.fallback });
    }
    const survived: Failure | null = gateOutcome.survived;

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
        gates: gates === null ? null : gates.word,
        costUsd: passCost,
      }),
      model: config.model,
      span: changedSpans(beforeText, text, chapter),
      tokens: { in: usage.in, out: usage.out },
      costUsd: passCost,
      at: now(),
    });

    // 11. `done`: the writer's tokens only (the engine adds each gate's). `STEP_CLOSED` is the
    //     close this pass asked for; a transport failure gets one more try (`closeTick.ts`).
    const passMode: WriteMode | null = lane.mode();
    const { closed, failure: closeFailure } = await closeTick({
      engine,
      stepId: job.stepId,
      log: deps.log,
      body: {
        leaseId: job.leaseId,
        note: `глава ${String(chapter)}: ${String(parsed.chars)} знаков, ${String(parsed.blocks.length)} абзацев`,
        model: config.model,
        tokensIn: lane.writerTokens().in,
        tokensOut: lane.writerTokens().out,
        seams: [],
        // BOOK-173 §4: how this pass wrote — the one thing the engine cannot state itself.
        ...(passMode === null ? {} : { mode: passMode }),
        // BOOK-DOC-80: which tiers judged it, so `change_plans` and the sample queue learn it.
        ...(gates === null
          ? {}
          : {
              verification: {
                gatesMode: gates.gatesMode,
                why: gates.why,
                tier1Verdict: gates.tier1Verdict,
                tier1Usd: gates.tier1Usd,
              },
            }),
      },
    });
    if (closed === null) {
      // The gate's own failure is why the verdicts never arrived; the close's refusal is its own.
      const why: Failure =
        closeFailure?.code === 'VERDICTS_REQUIRED' && survived !== null
          ? survived
          : (closeFailure ?? { code: null, detail: 'шаг не закрылся: движок не подтвердил закрытие' });
      return await lane.park({ ...why, fallback: why === survived ? readerFallbacks.gate : readerFallbacks.stopped });
    }

    const result: PassResult = {
      status: 'closed',
      stepId: closed.stepId,
      changeId: job.changeId,
      tokens: lane.writerTokens(),
      costUsd: passCost,
    };
    await lane.transcript(result);
    deps.log(
      `[writer] closed ${closed.stepId}: ${closed.outcome}, глава ${String(chapter)}, ${String(parsed.chars)} знаков, $${passCost.toFixed(4)}`,
    );
    return result;
  } catch (error) {
    const stepped = gone(error);
    if (stepped !== null) return stepped;
    const parked = await lane.park(failureOf(error));
    await lane.transcript(parked);
    return parked;
  }
}
