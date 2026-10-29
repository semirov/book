/**
 * What the pass needs from the outside world, per chapter: the model calls, the stages, the
 * text, the transcript and the two gates (`docs/writer-lane.md` §1–§2, §5).
 *
 * `pass.ts` decides *what happens and in which order*; this file does the talking. Everything is
 * injected, so a test drives a real pass through a fixture engine and a scripted provider.
 *
 * **The writer writes nowhere** (BOOK-187, ADR-043 §3 row 4): the answer is held in memory and
 * one `land` call carries it. There is no pre-image, because nothing was touched before the
 * landing — a refusal leaves the rows exactly as they were, which is the pre-image.
 */

import { type WriterAssignment } from '@book/shared';

import { sha256Hex } from '../util/hash.ts';
import type { ChapterTextView } from '../engine/text.ts';
import type { SentencePatchEdit } from '../sentences/transform.ts';
import type { LandView } from './client.ts';
import type { PassEstimate } from './estimate.ts';
import type { GateRoleName } from './gates.ts';
import { createGates } from './laneGates.ts';
import type { WriteMode } from './mode.ts';
import { costUsd, type PipelineUsage } from './pipeline.ts';
import { noChapterText, type ChapterTextLookup } from './prompt.ts';
import { estimateUsage, type ProviderResult, type WriterMessage } from './provider.ts';
import { PassRefusal, codeOf, failureOf, readerFallbacks, readerReason, reasonOf, type Failure, type ParkInput } from './reasons.ts';
import {
  storeTranscript,
  type CallKind,
  type CallRecord,
  type CallVerdict,
  type PatchReceipt,
  type PromptSectionFact,
} from './transcript.ts';
import type { GatesRecord } from './verify/run.ts';
import { servesText } from './putBack.ts';
import { emitStage, stageLogLine, stageSummary, type StageEmitInput, type StageSink } from './stages.ts';
import { validateAnswer } from './validate.ts';

import type { Answer, AskOptions, Lane, LaneInput, PassResult } from './laneTypes.ts';

/** A step the engine already took away: a scheduling event, never a prose event. */
export const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type {
  Answer,
  AskOptions,
  GateRun,
  Lane,
  LaneInput,
  PassResult,
  PassStatus,
  ProviderCall,
} from './laneTypes.ts';

function addUsage(total: PipelineUsage, usage: PipelineUsage): PipelineUsage {
  return {
    in: total.in + usage.in,
    out: total.out + usage.out,
    cachedIn: total.cachedIn + usage.cachedIn,
    // BOOK-219: the flag is sticky — one estimated call makes the pass's line an estimate.
    ...(total.estimated === true || usage.estimated === true ? { estimated: true } : {}),
  };
}

// The text values live apart (`laneText.ts`) because this file is at its arch bound.
export { assignmentData, charsOf, finalize, mergeContinuation } from './laneText.ts';

export function createLane(input: LaneInput, job: WriterAssignment, chapter: number, answered: Record<GateRoleName, boolean>): Lane {
  const { config, engine, bookRoot, now } = input;
  const sink: StageSink = { stage: (event) => engine.stage(event) };
  const calls: CallRecord[] = [];
  const written = { in: 0, out: 0 };
  /** The prompt of calls that threw (BOOK-219): the request left, so its prompt was paid for. */
  let attempted: PipelineUsage = { in: 0, out: 0, cachedIn: 0 };
  /** The last landing of this pass, as the engine answered it: what a revert must move off. */
  let landing: { rev: number; sha: string } | null = null;
  let all: PipelineUsage = { in: 0, out: 0, cachedIn: 0 };
  /** The prompt's sections as facts (AC7): ids, hashes, lengths — the receipt's only census. */
  let sections: PromptSectionFact[] = [];
  let promptSha256: string | null = null;
  /** BOOK-173 §5: the prefix the pass was built with — the cache identity the receipt carries. */
  let promptPrefix: string | null = null;
  // BOOK-173 §2/§4: the mode, the patch and the character edits the landing carries.
  let mode: WriteMode | null = null;
  let patch: PatchReceipt | null = null;
  let sentences: ReadonlyArray<SentencePatchEdit> | null = null;
  let estimate: PassEstimate | null = null;
  // BOOK-DOC-80: which tiers judged the pass — recorded so `change_plans` and the receipt agree.
  let gates: GatesRecord | null = null;
  // The code of a stop, for the receipt; the sentence the reader gets is built in `park`.
  let failure: Failure | null = null;
  /** The rows the prompt quotes, loaded per call: the engine answers, the writer caches. */
  const views = new Map<number, ChapterTextView>();

  /** Observability, not a fact: a stage sink that refuses or throws is logged, never fatal — an
   *  auxiliary call must not escalate a step whose text already landed (owner, 2026-10-28). */
  /**
   * §10.8 — every stage of this pass carries the ladder: the attempt (the engine's lease number),
   * its ceiling, the widening the attempt runs under and the desperate marker. One place, so no
   * emitter can forget a field and read as a different attempt.
   */
  function withLadder(stage: StageEmitInput): StageEmitInput {
    return {
      ...stage,
      attempt: stage.attempt ?? job.attempt,
      maxAttempts: stage.maxAttempts ?? job.maxAttempts,
      iteration: stage.iteration ?? job.cycle,
      widened: stage.widened ?? job.widened?.code ?? null,
      desperate: stage.desperate ?? job.desperate,
    };
  }

  async function emit(raw: StageEmitInput): Promise<void> {
    const stage = withLadder(raw);
    try {
      input.log(stageLogLine(stage.at, stage.stage, stage.summary));
      const stored = await emitStage(sink, stage);
      if (!stored.ok) input.log(`[writer] stage ${stage.stage} not stored: ${stored.code}`);
    } catch (error) {
      input.log(`[writer] stage ${stage.stage} not emitted: ${failureOf(error).detail}`);
    }
  }

  async function beat(): Promise<void> {
    try {
      await engine.beat(job.leaseId);
    } catch (error) {
      throw new PassRefusal(`аренда прохода не подтверждена: ${reasonOf(error)}`, codeOf(error));
    }
  }

  async function ask(
    kind: CallKind,
    messages: WriterMessage[],
    purpose?: 'draft' | 'repair' | 'continue',
    options?: AskOptions,
  ): Promise<ProviderResult> {
    await beat();
    if (purpose !== undefined) {
      const call = calls.filter((entry) => entry.kind === kind).length + 1;
      await emit({
        stage: 'drafting',
        chapter,
        passId: job.stepId,
        changeId: job.changeId,
        summary: stageSummary.draftingStarted({
          call,
          chars: messages.reduce((sum, message) => sum + message.content.length, 0),
          purpose,
        }),
        model: config.model,
        at: now(),
      });
    }
    const remaining = config.maxTokensPerPass - (all.in + all.out);
    if (remaining <= 0) throw new PassRefusal('лимит токенов на проход исчерпан');
    // The causality judge and Tier 1 are bounded questions, not writing turns: the gate's cap.
    const baseCap =
      options?.maxTokens ??
      (kind.startsWith('gate:') || kind === 'judge' || kind === 'tier1' ? config.gateTokens : config.maxTokensPerCall);
    // §10.8: the desperate sixth is the cheapest honest path — one call at 8 000 tokens, never a
    // second full-size reasoning pass.
    const cap = Math.min(job.desperate ? config.desperateTokens : baseCap, remaining);
    let result: ProviderResult;
    try {
      result = await input.provider({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        apiModel: config.apiModel,
        messages,
        maxTokens: cap,
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      // A failed call still sent its prompt: the pass pays for the request it made, so the prompt
      // is charged at the estimate and the park can never read as a free pass (BOOK-219).
      const spent = estimateUsage(messages, '', cap);
      all = addUsage(all, spent);
      attempted = addUsage(attempted, spent);
      throw new PassRefusal(reasonOf(error), codeOf(error));
    }
    // The writer's own tokens: what `done` reports — each gate's verdict row is added by the close.
    if (kind === 'draft' || kind === 'repair' || kind === 'continue') {
      written.in += result.usage.in;
      written.out += result.usage.out;
    }
    all = addUsage(all, result.usage);
    // ADR-038 §2's honest limit: other weights are evidence, not a refusal — one line, no vertex
    // id in a row (a receipt names shas and lengths, never a model string in free text).
    if (result.responseModel !== config.model && result.responseModel !== config.apiModel) {
      input.log(`[writer] модель ответила другими весами: ${result.responseModel} — проход идёт дальше`);
    }
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    calls.push({
      kind,
      at: now(),
      system,
      user: messages
        .filter((message) => message.role !== 'system')
        .map((message) => message.content)
        .join('\n\n'),
      answer: result.text,
      usage: result.usage,
      // BOOK-173 §5: the call's cache split and the prefix it was sent under, per call.
      cachedIn: result.usage.cachedIn,
      prefixSha256: sha256Hex(system),
    });
    if (purpose !== undefined) {
      await emit({
        stage: 'drafting',
        chapter,
        passId: job.stepId,
        changeId: job.changeId,
        summary: stageSummary.draftingReturned({
          chars: result.text.length,
          tokensIn: result.usage.in,
          tokensOut: result.usage.out,
        }),
        // The call's own numbers, which the engine's close reads: a reaped pass must not read free.
        model: config.model, tokens: { in: result.usage.in, out: result.usage.out },
        at: now(),
      });
    }
    return result;
  }

  function laneModel(): string | null { return calls.length === 0 ? null : config.model; }

  /**
   * A gate's verdict, on the call that produced it: the last call, and only when it is that gate's
   * own. A clean rights scan answers mechanically without a model call, and must not stamp the
   * consultant's answer with Gate B's `CLEAR`.
   */
  function markVerdict(kind: CallKind, verdict: CallVerdict | null): void {
    const last = calls.at(-1);
    if (verdict !== null && last !== undefined && last.kind === kind) last.verdict = verdict;
  }

  /** AC7: the receipt goes once, after the outcome — and a failure there can never change it. */
  function transcript(result: PassResult): Promise<void> {
    return storeTranscript({
      engine,
      log: input.log,
      passId: job.stepId,
      calls,
      sections,
      promptBundle: input.promptBundle,
      failure: result.status === 'closed' ? null : (failure?.code ?? null),
      // BOOK-173 §5 / BOOK-DOC-80: what the pass states about itself — codes, counts and hashes.
      facts: {
        mode,
        patch,
        gates,
        promptSha256,
        cachePrefix: promptPrefix,
        estimateUsd: estimate === null ? null : estimate.usd,
      },
    });
  }

  /** Park the pass: the note is a sentence, the log line and the transcript carry the code. */
  async function park(why: ParkInput): Promise<PassResult> {
    // A coded failure the table does not know still owes the reader a sentence, not a code word.
    const code = why.code ?? null;
    // BOOK-166: a released lease is not a failure — the step closed under us; one line, then next.
    if (code !== null && GONE_CODES.has(code)) {
      input.log('lease released by the engine — taking the next filing');
      return {
        status: 'gone',
        stepId: job.stepId,
        changeId: job.changeId,
        reason: 'lease released by the engine — taking the next filing',
        code,
      };
    }
    // A sentence the pass names itself wins: a revert must not read as a queue place.
    const sentence =
      why.sentence ?? readerReason(code, why.fallback ?? (code === null ? why.detail : readerFallbacks.stopped));
    failure = { code, detail: why.detail };
    input.log(`[writer] parked ${code ?? 'без кода'}: ${why.detail.slice(0, 300)}`);
    // BOOK-117: a parked pass spent money too — the writer's calls travel with the escalate and
    // each gate's verdict row is added by the close. A park before the first call claims neither;
    // BOOK-219: a call that threw is paid for, so its prompt travels too, and the ledger's word
    // says whether these numbers were measured or estimated.
    const spent = all.in + all.out === 0
      ? { tokensIn: 0, tokensOut: 0 }
      : {
          model: config.model,
          tokensIn: written.in + attempted.in,
          tokensOut: written.out + attempted.out,
          provenance: all.estimated === true ? ('pipeline-estimated' as const) : ('pipeline' as const),
        };
    try {
      await engine.escalate(job.leaseId, sentence.slice(0, 400), spent, why.cause ?? 'failed');
    } catch (error) {
      // A step already gone (expired pass, wall): the escalate is a no-op line, never a park.
      const code = codeOf(error);
      if (code === 'LEASE_RELEASED' || code === 'STEP_WALL' || code === 'STEP_CLOSED') {
        input.log(`[writer] escalate пропущен (${code}): шаг уже закрыт движком`);
      } else {
        input.log(`[writer] escalate refused: ${reasonOf(error)}`);
      }
    }
    await emit({
      stage: 'refused',
      chapter,
      passId: job.stepId,
      changeId: job.changeId,
      summary: stageSummary.refused({ reason: sentence }),
      model: laneModel(), // no call, no pin: a park before the model ran claims no model, no money
      at: now(),
    });
    const parked: PassResult = {
      status: 'parked',
      stepId: job.stepId,
      changeId: job.changeId,
      ...(code === null ? {} : { code }),
      ...(why.cause === 'refused' ? { filingRefused: true } : {}),
      // The reader's sentence, not the code word (the code lives in the log and transcript).
      reason: sentence,
      tokens: { ...written },
      costUsd: costUsd(config.pipeline.pricing, all),
    };
    // AC7: the receipt is sent once, after the outcome — and cannot change it.
    await transcript(parked);
    return parked;
  }

  /**
   * `land`: the text travels in the request. A refusal touches nothing — the rows keep the text
   * the site serves — so there is no image to put back (BOOK-187). The answer carries the plan the
   * engine froze with the revision (BOOK-173 §7), and the mode, the edits and the estimate this
   * pass states about itself.
   *
   * A lost answer is not a refused landing (BOOK-219): the rows are the fact, so the chapter is
   * read back, and one that already serves this text *is* this pass's landing — closed or taken
   * back like any other, instead of parking over live prose with no revision of ours on record.
   */
  async function land(value: string): Promise<LandView | null> {
    try {
      const published = await engine.land(job.leaseId, {
        text: value,
        // BOOK-222: the lane's landing is a candidate; the close publishes it, once.
        provisional: true,
        ...(sentences === null ? {} : { sentences }),
        ...(mode === null ? {} : { mode }),
        ...(estimate === null ? {} : { estimateUsd: estimate.usd }),
      });
      landing = { rev: published.revAfter, sha: published.sha };
      return published;
    } catch (error) {
      if ((await servesText(engine, chapter, value)) !== true) throw new PassRefusal(reasonOf(error), codeOf(error));
      input.log(`[writer] land не ответил (${codeOf(error) ?? 'транспорт'}): глава уже несёт этот текст — считаю публикацией`);
      // The revision this pass stands on is unknown; the way back says so instead of guessing.
      landing = null;
      return null;
    }
  }

  /** Read the rows a prompt needs in one call; the pass decides what to do with a failure. */
  async function loadText(chapters: number[]): Promise<void> {
    const wanted = [...new Set(chapters.filter((n) => Number.isInteger(n) && n >= 1))];
    if (wanted.length === 0) return;
    const answer = await engine.text(wanted);
    for (const view of answer.chapters) views.set(view.n, view);
  }

  const textOf: ChapterTextLookup = (n) => views.get(n) ?? noChapterText(n);

  function check(value: string, finishReason?: string | null): Answer {
    return validateAnswer(value, { chapter, finishReason: finishReason ?? null });
  }

  const gateRunner = createGates({ deps: { ask, emit, loadText, textOf, land, check, markVerdict }, config, engine, bookRoot, chapter, job, answered, now, log: input.log });

  return {
    emit,
    ask,
    park,
    remember: (value) => {
      if (value !== null) failure = value;
    },
    loadText,
    textOf,
    land,
    transcript,
    check,
    runGate: (role) => gateRunner.runGate(role),
    runRightsGate: () => gateRunner.runRightsGate(),
    reviseText: (findings) => gateRunner.reviseText(findings),
    usage: () => all,
    // A gate call that threw has no verdict row to be charged from, so its prompt is reported
    // with the writer's tokens: the close takes the larger of the two, and the money is counted.
    writerTokens: () => ({ in: written.in + attempted.in, out: written.out + attempted.out }),
    estimated: () => all.estimated === true,
    landedAt: () => landing,
    model: () => laneModel(),
    setPrompt: (value) => {
      sections = value.sections;
      promptSha256 = value.promptSha256;
      promptPrefix = value.prefixSha256;
    },
    setMode: (nextMode, nextPatch, nextSentences) => {
      mode = nextMode;
      patch = nextPatch;
      sentences = nextSentences ?? null;
    },
    mode: () => mode,
    setEstimate: (value) => {
      estimate = value;
    },
    setGates: (value) => {
      gates = value;
    },
  };
}
