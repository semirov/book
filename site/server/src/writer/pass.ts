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
 * A failure **after** the lease is parked: `escalate` with one plain Russian sentence plus a
 * `refused` stage carrying the same sentence — a pass is never silently dropped.
 *
 * `landed` is emitted once per pass, after the gates, and carries the pass's whole money line
 * (writer calls and gate calls). `done` carries the writer's own tokens only: the engine adds
 * each gate's tokens from its verdict rows, so the step total is not counted twice.
 */

import { readFileSync } from 'node:fs';

import { CHAPTER_CHARS, TOTAL_CHAPTERS, isChapterNumber, type BudgetDto, type WriterAssignment } from '@book/shared';

import { formatUsd } from '../budget.ts';
import { chapterPath, isWrittenChapter, readChapter } from '../engine/text.ts';
import { parseChapter } from '../ingest/parseChapter.ts';
import type { DoneView, EngineClient, EngineStateView, StartView } from './client.ts';
import { estimatePassUsd, type PassEstimate } from './estimate.ts';
import { createLane, finalize, mergeContinuation, charsOf, assignmentData, reasonOf, type Answer, type GateRun, type Lane, type PassResult, type ProviderCall } from './passLane.ts';
import { costUsd } from './pipeline.ts';
import { buildContinuePrompt, buildWriterPrompt, type BuiltPrompt, type WriterAssignmentData } from './prompt.ts';
import type { WriterMessage } from './provider.ts';
import { changedSpans } from './span.ts';
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
  /** Lanes to ask for the next job, in order. Forward first: the book is written forward. */
  lanes?: Array<'fwd' | 'bwd'>;
};

/** The synthetic assignment a dry run prints: no engine, no lease, clearly marked `dryRun`. */
export type DryRunPlan = { dryRun: true; assignment: WriterAssignmentData; prompt: BuiltPrompt; summary: string };

export function dryRunPlan(input: { bookRoot: string; chapter: number }): DryRunPlan {
  if (!isChapterNumber(input.chapter)) {
    throw new Error(`главы ${String(input.chapter)} нет: глава — число от 1 до ${String(TOTAL_CHAPTERS)}`);
  }
  const assignment: WriterAssignmentData = {
    chapter: input.chapter,
    pass: 'draft',
    intent: 'пробный прогон (dryRun): без модели, без записи',
    interventionKind: null,
    premise: { intent: 'пробный прогон (dryRun): замысел не читается', kind: null },
    expectation: { chars: { min: CHAPTER_CHARS.min, max: CHAPTER_CHARS.max } },
  };
  const prompt = buildWriterPrompt({ bookRoot: input.bookRoot, assignment });
  return {
    dryRun: true,
    assignment,
    prompt,
    summary: `глава ${String(input.chapter)}: ${String(prompt.sections.length)} разделов, ${String(prompt.system.length + prompt.user.length)} знаков`,
  };
}

/** The model's first answer, with one retry that carries the reason it was refused. */
async function draftAnswer(lane: Lane, built: BuiltPrompt): Promise<Answer> {
  const request: WriterMessage[] = [
    { role: 'system', content: built.system },
    { role: 'user', content: built.user },
  ];
  const first = await lane.ask('draft', request, 'draft');
  const checked = lane.check(first.text, first.finishReason);
  if (checked.ok) return checked;
  const reason = checked.reason;
  const second = await lane.ask('repair', [
    ...request,
    { role: 'assistant', content: first.text.slice(0, 1_500) },
    {
      role: 'user',
      content: `## Отказ\n\nПредыдущий ответ не прошёл проверку: ${reason}.\nВерни главу заново, целиком: первая строка — название, вторая — пустая, дальше проза. Причину отказа учти.`,
    },
  ]);
  return lane.check(second.text, second.finishReason);
}

/** Continuations keep writing until the chapter reaches the thin line or the budget stops it. */
async function continueDraft(lane: Lane, input: { bookRoot: string; chapter: number; text: string; max: number }): Promise<string> {
  let text = input.text;
  let continuations = 0;
  while (continuations < input.max && charsOf(input.chapter, text) < CHAPTER_CHARS.min) {
    const continuation = buildContinuePrompt({ bookRoot: input.bookRoot, written: text });
    const more = await lane.ask(
      'continue',
      [
        { role: 'system', content: continuation.system },
        { role: 'user', content: continuation.user },
      ],
      'continue',
    );
    const next = lane.check(mergeContinuation(input.chapter, text, more.text), more.finishReason);
    // A continuation that breaks a rule is dropped: the chapter that validates already stands.
    if (!next.ok || next.text.length <= text.length) break;
    text = finalize(next.text);
    continuations += 1;
  }
  return text;
}

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

  // 1. The money guard (§6, BOOK-117): a spent day, or a pass that would cross a cap, does not
  //    even ask for a job — nothing is opened and the queue stays exactly as it was.
  let state: EngineStateView;
  try {
    state = await engine.state();
  } catch (error) {
    return { status: 'refused', reason: reasonOf(error) };
  }
  // Tokens are information, never a bound (the owner's instruction, 2026-10-27): the $ cap is
  // the bound, so `state.tokens.today` is not read here at all.
  const budget: BudgetDto | null = state.budget ?? null;
  let estimate: PassEstimate | null = null;
  if (budget === null) {
    // An engine from before the cap reports no money. The pass proceeds and says so: a silent
    // pretend-bound is worse than a bound nobody can read.
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
    if (deps.chapter !== null && deps.chapter !== undefined) {
      picked = await engine.pass(deps.chapter, config.session);
    } else {
      picked = null;
      for (const lane of deps.lanes ?? ['fwd', 'bwd']) {
        picked = await engine.next(lane, config.session);
        if (picked !== null) break;
      }
    }
  } catch (error) {
    // A refusal before the lease is a fact about the day, not a parked pass.
    return { status: 'refused', reason: reasonOf(error) };
  }
  if (picked === null) return { status: 'idle', reason: 'в полосе нет работы' };

  const job: WriterAssignment = picked;
  if (typeof job.chapter !== 'number') {
    // A `front` step carries no chapter, and the stage store resolves the chapter from the step:
    // there is nowhere to put a `refused` stage, so the plain sentence is the whole record.
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

  try {
    // 3. `queued`: the engine opened the step; the writer is the one that says so.
    await lane.emit({
      stage: 'queued',
      chapter,
      passId: job.stepId,
      changeId: job.changeId,
      summary: stageSummary.queued({ chapter, pass: job.pass, premise: job.premise?.intent ?? null, intent: job.intent }),
      model: null,
      at: now(),
    });

    // A resumed step already has its text on disk: the lane continues at the gates, not at the pen.
    const resume = job.landed === true;
    let text = '';

    if (!resume) {
      // 4. `start`, then the pre-image — before a single byte of the chapter changes.
      let started: StartView;
      try {
        started = await engine.start(job.leaseId);
      } catch (error) {
        return await lane.park(reasonOf(error));
      }
      if (typeof started.sha !== 'string') return await lane.park('движок не зафиксировал исходный текст главы');
      try {
        lane.preSnapshot(now());
      } catch {
        return await lane.park('не удалось сохранить снимок главы перед проходом');
      }
      beforeText = readChapter(bookRoot, chapter).exists ? readFileSync(chapterPath(bookRoot, chapter), 'utf8') : '';

      // 5. The prompt, and the stage that says it was assembled.
      let built: BuiltPrompt;
      try {
        built = buildWriterPrompt({ bookRoot, assignment: assignmentData(job) });
      } catch (error) {
        return await lane.park(`промпт не собран: ${error instanceof Error ? error.message : 'ошибка'}`.slice(0, 300));
      }
      lane.setPrompt(built.sections.length, built.promptSha256);
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
        }),
        model: null,
        at: now(),
      });

      // 6. The belt (§6): the money is still unspent. The real prompt can be larger than the
      //    pre-estimate, and the ledger is shared — another lane may have spent the headroom
      //    while this pass was being opened. Price the real prompt against the ledger as it is
      //    now, and park this pass alone if it would cross a cap.
      if (budget !== null) {
        try {
          const fresh: BudgetDto | null = (await engine.state()).budget ?? null;
          if (fresh !== null) {
            const real = estimatePassUsd({
              pricing: config.pipeline.pricing,
              promptChars: built.system.length + built.user.length,
              continueMax: config.continueMax,
            });
            lane.setEstimate(real);
            const crossed = capLine(fresh, real.usd);
            if (crossed !== null) {
              deps.log(`[writer] ${crossed}`);
              return await lane.park(crossed);
            }
          }
        } catch (error) {
          // A failed re-read is not a licence to spend: the pre-estimate already passed, and the
          // engine refuses the next call of a pass it will not hand out.
          deps.log(`[writer] пересчёт оценки не выполнен: ${reasonOf(error)}`);
        }
      }

      // 7. The model: one answer, one retry with the reason, then the continuation calls.
      const checked = await draftAnswer(lane, built);
      if (!checked.ok) {
        return await lane.park(`ответ модели не прошёл проверку: ${checked.code}: ${checked.reason}`.slice(0, 300));
      }
      text = finalize(checked.text);
      text = await continueDraft(lane, { bookRoot, chapter, text, max: config.continueMax });

      // 8. The write, and the landing that makes it a revision.
      try {
        lane.writeText(text);
      } catch {
        return await lane.park('не удалось записать главу');
      }
      try {
        await engine.land(job.leaseId);
      } catch (error) {
        return await lane.park(reasonOf(error));
      }
      // A landing drops the verdicts of the previous revision: both gates are asked again.
      answered.editor = false;
      answered.consultant = false;
    } else {
      // A resumed step whose file vanished has nothing to gate: say so instead of closing blind.
      if (!readChapter(bookRoot, chapter).exists) return await lane.park('текста главы нет на диске — проход не возобновить');
      text = readFileSync(chapterPath(bookRoot, chapter), 'utf8');
      beforeText = text;
    }

    // 9. The gates: editor, then consultant; at most one revision cycle for the whole pass.
    let revisions = 0;
    for (;;) {
      const editor: GateRun = await lane.runGate('editor');
      const consultant: GateRun | null = editor.revise ? null : await lane.runGate('consultant');
      if (!editor.revise && consultant?.revise !== true) break;
      if (revisions >= MAX_REVISIONS) break;
      revisions += 1;
      const revised = await lane.reviseText([...editor.findings, ...(consultant?.findings ?? [])]);
      if (revised === null) return await lane.park('правка после замечаний гейта не прошла проверку');
      text = revised;
      answered.editor = false;
      answered.consultant = false;
    }

    // 10. `landed`: one fact for the pass — the span, the tokens, the money.
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
        costUsd: passCost,
      }),
      model: lane.model() ?? config.model,
      span: changedSpans(beforeText, text, chapter),
      tokens: { in: usage.in, out: usage.out },
      costUsd: passCost,
      at: now(),
    });

    // 11. `done`: the writer's tokens only; the engine adds each gate's from its verdict rows.
    let closed: DoneView;
    try {
      closed = await engine.done({
        leaseId: job.leaseId,
        note: `глава ${String(chapter)}: ${String(parsed.chars)} знаков, ${String(parsed.blocks.length)} абзацев`,
        model: lane.model() ?? config.model,
        tokensIn: lane.writerTokens().in,
        tokensOut: lane.writerTokens().out,
        seams: [],
      });
    } catch (error) {
      return await lane.park(reasonOf(error));
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
    const parked = await lane.park(reasonOf(error));
    lane.transcript(parked);
    return parked;
  }
}
