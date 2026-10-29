/**
 * One writer pass, end to end (`docs/writer-lane.md` §1, §5–§6).
 *
 * ```
 * state → money guard (estimate vs the caps) → assignment → queued → start → prompt (rows)
 *   → read → belt (re-estimate the real prompt) → model call(s) → validate (one retry with the
 *   reason) → continuation calls → land (the text travels in the request) → gates (verdict ×2, at
 *   most one revision cycle) → done (the close; it announces the landing) → landed (the stage)
 * ```
 *
 * Nothing is written until `land`, and the only thing written is a row (BOOK-187): the writer
 * holds the chapter in memory, sends it, and the engine publishes it. There is no manuscript file
 * and no pre-image to keep. A base that moved is answered by the writer at `start` (`relevance.ts`),
 * and every exit without `done` takes this pass's own landing back (`recovery.ts`, BOOK-219).
 *
 * Everything the pass touches is injected: the engine client, the model transport, the clock and
 * the logger. The pass holds no database, no socket and no key of its own; the talking lives in
 * `passLane.ts`, the prompts and the answer contracts in `prompt.ts` / `gates.ts`.
 *
 * A refusal the engine states (`CHAPTER_WRITTEN`, `PASS_LEASED`, `TOKENS_EXHAUSTED`) is returned,
 * never thrown. The bound this file enforces is money, not tokens: the estimate (`estimate.ts`)
 * is checked before the pass is opened and again, from the real prompt, before the first call.
 * A failure after the lease parks the pass — one plain sentence plus a `refused` stage, never
 * silently dropped. Past the first landing a failure is auxiliary instead (owner, 2026-10-28):
 * a stage, a transcript or an engine transport that fails is logged, never escalated over text
 * that landed; the close is the fact that must land.
 *
 * `landed` carries the pass's whole money line (writer calls and gate calls); `done` carries the
 * writer's own tokens only, because the engine adds each gate's from its verdict rows.
 */

import { isChapterNumber, type BudgetDto, type WriterAssignment } from '@book/shared';

import { formatUsd } from '../budget.ts';
import { readBuildStamp } from '../buildStamp.ts';
import { isWrittenView } from '../engine/text.ts';
import type { EngineClient, EngineStateView } from './client.ts';
import { estimatePassUsd, type PassEstimate } from './estimate.ts';
import { createLane, finalize, assignmentData, type GateRun, type PassResult, type ProviderCall } from './passLane.ts';
import { buildWriterPrompt, chapterQuote, type BuiltPrompt } from './prompt.ts';
import { dryRunPlan } from './dryRun.ts';
import { continueDraft, draftAnswer } from './answer.ts';
import { rightsRefusal } from './rightsGate.ts';
import { codeOf, failureOf, isTransportFailure, readerFallbacks, readerSentences, reasonOf, type Failure } from './reasons.ts';
import { closePass } from './closePass.ts';
import { backSentence } from './putBack.ts';
import { createRecovery } from './recovery.ts';
import { resumeBase, startWriting } from './relevance.ts';
import { stageSummary } from './stages.ts';
import type { WriterConfig } from './config.ts';

export type { PassResult, PassStatus, ProviderCall } from './passLane.ts';

/** One gate's revision in a pass, whatever the engine's cycle cap allows. */
const MAX_REVISIONS = 1;

/** Money with four decimals and a comma: `$0,0412` — the estimate line's own number. */
function usd4(value: number): string {
  return value.toFixed(4).replace('.', ',');
}

/** The pause sentence (§6), in the engine's own words: a day's cap lifts at 00:00 UTC. */
function pauseLine(capUsd: number): string {
  return `пауза · дневной потолок ${formatUsd(capUsd)} $ · возобновится в 00:00 UTC`;
}

/** The stop sentence (§6): the book's cap ends the book, not a day of it. */
function stopLine(capUsd: number): string {
  return `остановлено · потолок книги ${formatUsd(capUsd)} $`;
}

/**
 * The estimate against both caps. The book's cap wins, as it does in `budget.ts`: a pass that
 * would spend the book's last dollars is stopped, not paused. The engine's own line is used
 * when the engine already stated one, so a pause reads the same on every surface.
 */
function capLine(budget: BudgetDto, usd: number): string | null {
  if (budget.book.spentUsd + usd > budget.book.capUsd) {
    return budget.state === 'stop' ? budget.line : stopLine(budget.book.capUsd);
  }
  if (budget.day.spentUsd + usd > budget.day.capUsd) {
    return budget.state === 'pause' ? budget.line : pauseLine(budget.day.capUsd);
  }
  return null;
}

/** `[writer] оценка прохода $0,0412 (день 3,20 / 10,00, книга 12,40 / 1 000,00)` — one line. */
function estimateLine(estimate: PassEstimate, budget: BudgetDto): string {
  const day = `${formatUsd(budget.day.spentUsd)} / ${formatUsd(budget.day.capUsd)}`;
  const book = `${formatUsd(budget.book.spentUsd)} / ${formatUsd(budget.book.capUsd)}`;
  return `[writer] оценка прохода $${usd4(estimate.usd)} (день ${day}, книга ${book})`;
}

/**
 * BOOK-145: a step the engine already took away is not a failure of this pass — a step wall, a
 * released lease, a step closed by the engine. The lane says so in one line, asks `next` again at
 * once and never closes the dead step; a run that landed puts its own text back first (BOOK-219).
 */
const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type PassDeps = {
  config: WriterConfig;
  bookRoot: string;
  engine: EngineClient;
  provider: ProviderCall;
  now: () => number;
  log: (line: string) => void;
  /** A dry run builds the plan and stops: no engine call, no model call, no write. */
  dryRun?: boolean;
  /** ADR-043 G3: the prompt bundle this image carries, for the receipt; the build stamp otherwise. */
  promptBundle?: string | null;
  /** `--chapter N`: open that chapter's first pass instead of the lane's next slot. */
  chapter?: number | null;
  /** How to ask for work. `filing` is the door (BOOK-166); fwd/bwd stay for a direct walk. */
  lanes?: Array<'fwd' | 'bwd' | 'filing'>;
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
      deps.log(`[writer] dry-run ${dryRunPlan({ bookRoot, chapter }).summary}: ничего не открыто, модель не звана, текст не тронут`);
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
  if (budget === null) {
    // An engine from before the cap reports no money: a silent pretend-bound would be worse.
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
    if (deps.chapter !== null && deps.chapter !== undefined) {
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
    {
      config, bookRoot, engine, provider: deps.provider, now, log: deps.log,
      promptBundle: deps.promptBundle === undefined ? readBuildStamp().promptBundleSha : deps.promptBundle,
    },
    job, chapter, answered,
  );
  let beforeText = '';
  /** BOOK-219: the revision this run started from (or resumed at), and its sha. */
  let preRev: number | null = null;
  let preSha = '';
  let landedHere = false;
  /** BOOK-219: this run's own landing — the draft branch's, or a revision it re-landed. */
  const published = (): boolean => landedHere || lane.landedAt() !== null;
  /** The text as it now stands: the last revision this pass landed (or the resumed one). */
  let text = '';

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
   * landed has already published. The step closed `escalated:gate_timeout` and nobody else holds
   * this pass's `preRev`, so the text goes back first — `gone` on its own is only the answer when
   * the way back finds nothing of ours (`none`), exactly as the rights path already does it.
   */
  async function goneAfterBack(code: string | null, detail: string): Promise<PassResult | null> {
    const answer = goneOf(code, detail);
    if (answer === null) return null;
    if (!published()) return answer;
    const back = await recovery.takeBack('шаг снят движком');
    // `none` is the other owner's text; `unverified` is ours, still live — and says so in the log.
    if (back.kind === 'unverified') deps.log(`[writer] откат не подтверждён: ${back.detail}`);
    return answer;
  }

  /** One gate round: the editor, then the consultant when the editor asks for no revision. */
  async function gateRound(refusal?: string | null): Promise<
    | { ok: true; editor: GateRun; consultant: GateRun | null; rightsClosed: boolean }
    | { ok: false; failure: Failure }
  > {
    try {
      const editor = await lane.runGate('editor', refusal ?? null);
      const consultant = editor.revise ? null : await lane.runGate('consultant', refusal ?? null);
      // BOOK-61: Gate B last — it may close the step itself, so a refusal is the pass's answer.
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

    if (!resume) {
      // 4. `start`, then the pre-image — before a single byte of the chapter changes. A base the
      //    engine says has moved is answered by the writer here (`relevance.ts`), never parked.
      const opened = await startWriting({ engine, lane, job, chapter, log: deps.log });
      if (!opened.ok) {
        return (await goneAfterBack(opened.failure.code, opened.failure.detail)) ?? (await lane.park(opened.failure));
      }
      const started = opened.started;
      if (typeof started.sha !== 'string') return await lane.park({ detail: 'движок не зафиксировал исходный текст главы' });
      // The revision and the text this pass starts from: what a revert has to return to (BOOK-219).
      preRev = typeof started.expectedRev === 'number' ? started.expectedRev : null;
      preSha = started.sha;

      // 5. The prompt, and the stage that says it was assembled. The text is read from rows — the
      //    target and its two neighbours are everything a prompt may quote.
      let built: BuiltPrompt;
      try {
        await lane.loadText([chapter - 1, chapter, chapter + 1]);
        beforeText = chapterQuote(lane.textOf(chapter));
        built = buildWriterPrompt({ bookRoot, assignment: assignmentData(job), chapterText: lane.textOf });
      } catch (error) {
        return await lane.park({ detail: `промпт не собран: ${error instanceof Error ? error.message : 'ошибка'}`.slice(0, 300) });
      }
      lane.setPrompt(built);
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
            });
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

      // 7. The model: one answer, one retry with the reason, then the continuation calls.
      const checked = await draftAnswer(lane, built, deps.log);
      if (!checked.ok) {
        // Only the model's own refusal refuses the premise; a failed call, a cut answer or a
        // broken shape is a pass that broke, never the reader's intervention declined.
        return await lane.park({
          code: checked.code,
          detail: `ответ модели не прошёл проверку: ${checked.code}: ${checked.reason}`.slice(0, 300),
          fallback: readerFallbacks.gate,
          cause: checked.code === 'ANSWER_REFUSAL' ? 'refused' : 'failed',
        });
      }
      text = finalize(checked.text);
      text = await continueDraft(lane, { bookRoot, chapter, text, max: config.continueMax }, deps.log);

      // 8. The landing that makes the answer a revision — the text travels, no file is touched.
      try {
        await lane.land(text);
        landedHere = true;
      } catch (error) {
        return (await goneAfterBack(codeOf(error), reasonOf(error))) ?? (await lane.park(failureOf(error)));
      }
      // A landing drops the previous revision's verdicts: every gate is asked again.
      answered.editor = false;
      answered.consultant = false;
      answered.rights = false;
    } else {
      // A resumed step: the rows hold the landed text the gates may ask for below, and the base
      // its own re-landing returns to is the revision the step stands at — `start` on a landed
      // step answers it and changes nothing (BOOK-219).
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
      text = chapterQuote(lane.textOf(chapter));
      beforeText = text;
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
        const stepped = await goneAfterBack(round.failure.code ?? null, round.failure.detail);
        if (stepped !== null) return stepped;
        // A rights failure is not auxiliary: the step cannot close without an answer, and the
        // text it landed has no rights result, so it goes back before the pass parks.
        const code = round.failure.code ?? '';
        if (code.startsWith('RIGHTS') || code === 'GATE_UNPARSED') {
          const back = await recovery.takeBack('гейт не ответил');
          return await recovery.parkAfter({ ...round.failure, fallback: readerFallbacks.gate }, back, code.startsWith('RIGHTS') ? 'rights' : 'gate');
        }
        failed = round.failure;
        break;
      }
      const { editor, consultant, rightsClosed } = round;
      if (rightsClosed) {
        // The rights gate refused the text and the engine closed the step: no `done`, no revision.
        // The refused text is live, so it is taken back first, and the sentence says which of the
        // two happened — a refusal never reads as «правка не принята» over published prose.
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
      if (!editor.revise && consultant?.revise !== true) break;
      if (revisions >= MAX_REVISIONS) break;
      revisions += 1;
      const revised = await lane.reviseText([...editor.findings, ...(consultant?.findings ?? [])]);
      if (revised === null) {
        const back = await recovery.takeBack('правка не прошла проверку');
        return await recovery.parkAfter({ detail: 'правка после замечаний гейта не прошла проверку' }, back);
      }
      text = revised;
      answered.editor = false;
      answered.consultant = false;
      answered.rights = false;
    }
    if (failed !== null) {
      lane.remember(failed);
      deps.log(`[writer] гейт не ответил (${failed.code ?? 'без кода'}): ${failed.detail}`);
      // BOOK-219, the compensating revert: a pass that published and then lost its verdict takes
      // its own landing back before it parks — the engine requires `landed_at` to dispatch a gate.
      const back = await recovery.takeBack('гейт не ответил');
      if (back.kind !== 'none') return await recovery.parkAfter({ ...failed, cause: 'failed' }, back);
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
      failed,
      started: { rev: preRev, sha: preSha },
      landing: lane.landedAt(),
      landed: published(),
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
    // `park` sends the receipt itself, once, after the outcome it states.
    return await lane.park(failureOf(error));
  }
}
