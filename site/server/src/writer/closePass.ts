/**
 * The close of a landed pass (`docs/writer-lane.md` §1, steps 10–11).
 *
 * Two facts, in this order: `done` — the engine's close, which is where the reader is told the
 * chapter landed (BOOK-219: the `landed` push happens at the close, never at `land`) — and then
 * the `landed` stage (the span, the tokens, the money; a stage, so it can never throw). The stage
 * follows the close so that a close the engine refuses leaves no «глава написана» line behind.
 * A step that already closed answers `STEP_CLOSED`, which is that close and not a failure of this
 * pass; a transport failure gets one more try — and a `done` whose answer is lost is **read**
 * from the step (`/internal/trace`), never read as a failed close: the push may already have gone
 * out, and a restore would contradict it (BOOK-219).
 *
 * BOOK-219 adds one word to both: when any call of the pass had its usage read off the text
 * (`Lane.estimated`), the stage prints `≈` before the money and the close declares
 * `pipeline-estimated`, so the ledger row is priced **and** honest. It lives apart from `pass.ts`
 * because that file is at its arch bound and the close is a seam of its own.
 *
 * The invariant this file keeps with `pass.ts`: a pass either closes with `done`, or the chapter
 * goes back to the revision the pass found. A close the engine refuses is the last exit, so the
 * way back is taken here too, before the park.
 */

import type { WriterAssignment } from '@book/shared';

import { parseChapter } from '../ingest/parseChapter.ts';
import type { DoneView, EngineClient } from './client.ts';
import type { WriterConfig } from './config.ts';
import type { Lane, PassResult } from './passLane.ts';
import { costUsd } from './pipeline.ts';
import { putBack } from './putBack.ts';
import { failureOf, isTransportFailure, readerFallbacks, readerSentences, type Failure } from './reasons.ts';
import { changedSpans } from './span.ts';
import { stageSummary } from './stages.ts';

export type ClosePassInput = {
  lane: Lane;
  engine: Pick<EngineClient, 'done' | 'restore' | 'reconcile' | 'text' | 'step'>;
  config: WriterConfig;
  chapter: number;
  job: Pick<WriterAssignment, 'stepId' | 'changeId' | 'leaseId'>;
  /** The text as it now stands (the last revision the pass landed). */
  text: string;
  /** The chapter as the pass found it, for the span. */
  beforeText: string;
  /** A gate failure the pass survived, if any: it decides the sentence of a refused close. */
  failed: Failure | null;
  /** BOOK-219: what a refused close needs to put the chapter back where the pass found it. */
  started: { rev: number | null; sha: string };
  landing: { rev: number; sha: string } | null;
  landed: boolean;
  log: (line: string) => void;
  now: () => number;
};

export async function closePass(input: ClosePassInput): Promise<PassResult> {
  const { lane, engine, config, chapter, job, text, log } = input;
  const usage = lane.usage();
  const estimated = lane.estimated();
  const passCost = costUsd(config.pipeline.pricing, usage);
  const parsed = parseChapter(chapter, text);

  // `done`: a landed step closes on what it has; `STEP_CLOSED` is that close already made.
  let closed: DoneView | null = null;
  let closeFailure: Failure | null = null;
  /** The last attempt was a transport failure: the push may already have gone out (BOOK-219). */
  let uncertain = false;
  const close = (): Promise<DoneView> =>
    engine.done({
      leaseId: job.leaseId,
      note: `глава ${String(chapter)}: ${String(parsed.chars)} знаков, ${String(parsed.blocks.length)} абзацев`,
      model: config.model,
      tokensIn: lane.writerTokens().in,
      tokensOut: lane.writerTokens().out,
      seams: [],
      // BOOK-219: the close names the estimate, so the ledger row is priced *and* honest.
      provenance: estimated ? 'pipeline-estimated' : 'pipeline',
    });

  for (let attempt = 0; attempt < 2 && closed === null; attempt += 1) {
    try {
      closed = await close();
      uncertain = false;
    } catch (error) {
      closeFailure = failureOf(error);
      uncertain = isTransportFailure(closeFailure);
      // The step is closed either way; `done` on it is a no-op, and the pass says what it did.
      if (closeFailure.code === 'STEP_CLOSED') {
        closed = { stepId: job.stepId, outcome: 'already-closed', cascadeId: null, changeStatus: null };
        break;
      }
      if (!uncertain || attempt > 0) break;
      log(`[writer] done не прошёл (${closeFailure.code ?? 'транспорт'}): ${closeFailure.detail} — повтор`);
    }
  }
  // A lost answer is not a failed close (BOOK-219): the push may already have gone out, and a
  // restore would contradict it. The **step** is read instead of guessed, and the text only goes
  // back when the close is known to be missing. A step that cannot be read either leaves the
  // close unknown — nothing goes back then, and the sentence says so instead of claiming a revert.
  if (closed === null && uncertain) {
    try {
      const step = await engine.step(job.stepId);
      // A step closed as **this pass** is the close (`rewritten`, `holds`, `evaluated`, …). One
      // closed `escalated`/`interrupted` was taken away by the engine, and the chapter goes back.
      const taken = step.outcome === 'escalated' || step.outcome === 'interrupted';
      if (step.state === 'closed' && step.outcome !== null && !taken) {
        closed = { stepId: job.stepId, outcome: step.outcome, cascadeId: null, changeStatus: null };
      }
    } catch (error) {
      const read = failureOf(error);
      log(`[writer] закрытие не подтверждено (${read.code ?? 'транспорт'}): текст не откатываю — откат спорил бы с публикацией`);
      return await lane.park({
        code: read.code,
        detail: `закрытие не подтверждено: ${read.detail}`.slice(0, 300),
        fallback: readerFallbacks.stopped,
        sentence: readerSentences.closeUncertain,
      });
    }
  }
  if (closed === null) {
    // The gate's own failure is why the verdicts never arrived; the close's refusal is its own.
    const why: Failure =
      closeFailure?.code === 'VERDICTS_REQUIRED' && input.failed !== null
        ? input.failed
        : (closeFailure ?? input.failed ?? { code: null, detail: 'шаг не закрылся: движок не подтвердил закрытие' });
    // BOOK-219: a close that never happened leaves no `done`, so the invariant applies here too —
    // the chapter goes back to where the pass found it, and the note says which of the two
    // happened instead of a queue claim over a live revision.
    const back = await putBack({
      engine,
      job,
      chapter,
      started: input.started,
      landing: input.landing,
      landed: input.landed,
      text,
      why: 'шаг не закрылся',
      log,
    });
    return await lane.park({
      ...why,
      fallback: why === input.failed ? readerFallbacks.gate : readerFallbacks.stopped,
      sentence: back.kind === 'reverted' ? readerSentences.closeReverted : readerSentences.closeStanding,
      ...(back.kind === 'unverified' ? { detail: `${why.detail} · ${back.detail}`.slice(0, 300) } : {}),
    });
  }

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
      estimated,
    }),
    model: config.model,
    span: changedSpans(input.beforeText, text, chapter),
    tokens: { in: usage.in, out: usage.out },
    costUsd: passCost,
    at: input.now(),
  });

  const result: PassResult = {
    status: 'closed',
    stepId: closed.stepId,
    changeId: job.changeId,
    tokens: lane.writerTokens(),
    costUsd: passCost,
  };
  await lane.transcript(result);
  log(
    `[writer] closed ${closed.stepId}: ${closed.outcome}, глава ${String(chapter)}, ${String(parsed.chars)} знаков, $${passCost.toFixed(4)}`,
  );
  return result;
}
