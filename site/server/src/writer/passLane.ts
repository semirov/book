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

import { readFileSync } from 'node:fs';

import { type WriterAssignment } from '@book/shared';

import { assignmentData } from './laneText.ts';
import type { ChapterTextView } from '../engine/text.ts';
import type { EngineClient, GateAssignmentView } from './client.ts';
import { buildGatePrompt, type GateFinding, type GateRoleName, type RightsGateRun } from './gates.ts';
import { costUsd, type PipelineUsage } from './pipeline.ts';
import {
  buildWriterPrompt,
  chapterQuote,
  noChapterText,
  type ChapterTextLookup,
} from './prompt.ts';
import { estimateUsage, type ProviderRequest, type ProviderResult, type WriterMessage } from './provider.ts';
import { PassRefusal, codeOf, failureOf, readerFallbacks, readerReason, reasonOf, type Failure, type ParkInput } from './reasons.ts';
import { storeTranscript, type CallKind, type CallRecord, type CallVerdict, type PromptSectionFact } from './transcript.ts';
import { rightsRunner } from './rightsGate.ts';
import { emitStage, stageLogLine, stageSummary, type StageEmitInput, type StageSink } from './stages.ts';
import { validateAnswer } from './validate.ts';
import { askGateAnswer } from './gateAnswer.ts';
import { reviseAnswer } from './answer.ts';
import type { WriterConfig } from './config.ts';

export type PassStatus = 'closed' | 'idle' | 'parked' | 'refused' | 'gone';

export type PassResult = {
  status: PassStatus;
  stepId?: string;
  changeId?: string | null;
  reason?: string;
  tokens?: { in: number; out: number };
  costUsd?: number;
  /** BOOK-166: the *filing* was refused (auditor said no, frozen chapter) — the queue moves on. */
  filingRefused?: boolean;
};

/** A step the engine already took away: a scheduling event, never a prose event. */
export const GONE_CODES = new Set(['STEP_WALL', 'LEASE_RELEASED', 'LEASE_NOT_FOUND']);

export type ProviderCall = (request: ProviderRequest) => Promise<ProviderResult>;

export type Answer = ReturnType<typeof validateAnswer>;


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

/** The index slice is a path the engine returned; a missing file is not a gate failure. */
function sliceText(path: string | null): string | null {
  if (path === null || path.length === 0) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export type LaneInput = {
  config: WriterConfig;
  bookRoot: string;
  engine: EngineClient;
  provider: ProviderCall;
  now: () => number;
  log: (line: string) => void;
  /** ADR-043 G3: the prompt bundle this image carries, recorded on every receipt row. */
  promptBundle: string | null;
};

export type GateRun = { revise: boolean; findings: GateFinding[] };


export type Lane = {
  emit(input: StageEmitInput): Promise<void>;
  ask(kind: CallKind, messages: WriterMessage[], purpose?: 'draft' | 'repair' | 'continue'): Promise<ProviderResult>;
  /** Park the pass: one reader's sentence, one `refused` stage; `cause` defaults to `failed`. */
  park(why: ParkInput): Promise<PassResult>;
  /** Remember a failure the pass survived: the transcript is where a survived failure is proved. */
  remember(failure: Failure | null): void;
  /** Load the rows a prompt will quote; a failed read is the caller's `park`, never a silent empty. */
  loadText(chapters: number[]): Promise<void>;
  /** The cached view of one chapter — `noChapterText` for anything not loaded. */
  textOf: ChapterTextLookup;
  /** The one way the pass's text becomes a fact: the request body carries it, no file (BOOK-187). */
  land(value: string): Promise<void>;
  /** The pass's receipt, sent once after its outcome is known; never fatal (AC7). */
  transcript(result: PassResult): Promise<void>;
  /** Validate one answer; `finishReason` is the provider's, because `length` is a cut chapter. */
  check(value: string, finishReason?: string | null): Answer;
  /** One gate; `refusal` is the reason a previous answer was not parsed, shown to the model once. */
  runGate(role: GateRoleName, refusal?: string | null): Promise<GateRun>;
  runRightsGate(): Promise<RightsGateRun>;
  reviseText(findings: GateFinding[]): Promise<string | null>;
  usage(): PipelineUsage;
  writerTokens(): { in: number; out: number };
  /** The pin (`provider/model`) once a call happened, `null` before one — never the wire id. */
  model(): string | null;
  /** The prompt's sections, as facts: ids, hashes and lengths — never the prompt itself. */
  setPrompt(value: { sections: PromptSectionFact[]; promptSha256: string }): void;
  /** BOOK-219: some call's usage was read off the text — the close and the park name the estimate. */
  estimated(): boolean;
  /** The revision the pass's own last landing published, `null` before it landed anything. */
  landedAt(): { rev: number; sha: string } | null;
};

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
  // The code of a stop, for the receipt; the sentence the reader gets is built in `park`.
  let failure: Failure | null = null;
  /** The rows the prompt quotes, loaded per call: the engine answers, the writer caches. */
  const views = new Map<number, ChapterTextView>();

  /** Observability, not a fact: a stage sink that refuses or throws is logged, never fatal — an
   *  auxiliary call must not escalate a step whose text already landed (owner, 2026-10-28). */
  async function emit(stage: StageEmitInput): Promise<void> {
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
    let result: ProviderResult;
    try {
      result = await input.provider({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        apiModel: config.apiModel,
        messages,
        maxTokens: Math.min(kind.startsWith('gate:') ? config.gateTokens : config.maxTokensPerCall, remaining),
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      // A failed call still sent its prompt: the pass pays for the request it made, so the prompt
      // is charged at the estimate and the park can never read as a free pass (BOOK-219).
      const spent = estimateUsage(messages, '');
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
    calls.push({
      kind,
      at: now(),
      system: messages.find((message) => message.role === 'system')?.content ?? '',
      user: messages
        .filter((message) => message.role !== 'system')
        .map((message) => message.content)
        .join('\n\n'),
      answer: result.text,
      usage: result.usage,
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
    return storeTranscript({ engine, log: input.log, passId: job.stepId, calls, sections,
      promptBundle: input.promptBundle, failure: result.status === 'closed' ? null : failure?.code ?? null });
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
      };
    }
    // A sentence the pass names itself wins: a revert must not read as «остаётся в очереди».
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
   * the site serves — so there is no image to put back (BOOK-187).
   */
  async function land(value: string): Promise<void> {
    try {
      const published = await engine.land(job.leaseId, { text: value });
      landing = { rev: published.revAfter, sha: published.sha };
    } catch (error) {
      throw new PassRefusal(reasonOf(error), codeOf(error));
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

  /** One gate: the dispatch, the prompt, the answer, the verdict. */
  async function runGate(role: GateRoleName, refusal?: string | null): Promise<GateRun> {
    if (answered[role]) return { revise: false, findings: [] };
    let gate: GateAssignmentView | null;
    try {
      gate = await engine.nextGate(role, config.session);
    } catch (error) {
      throw new PassRefusal(reasonOf(error), codeOf(error));
    }
    if (gate === null) throw new PassRefusal(`гейт ${role} не выдал задание на эту главу`);
    await loadText([chapter]);
    const gateAssignment = {
      chapter,
      pass: job.pass,
      intent: job.intent,
      premise: job.premise,
      cycle: gate.cycle,
      role,
      note: gate.note,
    };
    const gateAnswer = await askGateAnswer({
      role,
      build: (hint) =>
        buildGatePrompt({
          bookRoot,
          role,
          chapter,
          assignment: gateAssignment,
          landedText: chapterQuote(textOf(chapter)),
          chapterText: textOf,
          indexSlice: role === 'editor' ? sliceText(gate.indexSlice) : null,
          refusal: hint,
        }),
      ask: (messages) => ask(role === 'editor' ? 'gate:editor' : 'gate:consultant', messages),
      log: input.log,
      refusal: refusal ?? null,
    });
    const parsed = gateAnswer.parsed;
    let action: string;
    try {
      const verdict = await engine.verdict({
        stepId: gate.stepId,
        role,
        session: gate.session,
        verdict: parsed.verdict,
        findings: parsed.findings,
        // The pin, never the wire id: the verdict row is read by the ledger's arithmetic.
        model: config.model,
        tokensIn: gateAnswer.usage.in,
        tokensOut: gateAnswer.usage.out,
      });
      action = verdict.action;
    } catch (error) {
      throw new PassRefusal(reasonOf(error), codeOf(error));
    }
    answered[role] = true;
    markVerdict(role === 'editor' ? 'gate:editor' : 'gate:consultant', parsed.verdict);
    await emit({
      stage: 'verdict',
      chapter,
      passId: job.stepId,
      changeId: job.changeId,
      summary: stageSummary.verdict({
        role,
        verdict: parsed.verdict,
        findings: parsed.findings.length,
        blockers: parsed.findings.filter((finding) => finding.severity === 'blocker').length,
      }),
      model: config.model,
      at: now(),
    });
    return { revise: action === 'revise', findings: parsed.findings };
  }

  /** One revision of the landed text, with the findings as data. Throws on a model/engine failure. */
  async function reviseText(findings: GateFinding[]): Promise<string | null> {
    await loadText([chapter - 1, chapter, chapter + 1]);
    const rebuilt = buildWriterPrompt({ bookRoot, assignment: assignmentData(job), chapterText: textOf });
    const revised = await reviseAnswer({
      rebuilt,
      findings,
      ask: (messages) => ask('repair', messages, 'repair'),
      check,
      log: input.log,
    });
    if (revised === null) return null;
    await land(revised);
    return revised;
  }

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
    runGate: (role) => runGate(role),
    runRightsGate: async () => {
      const run = await rightsRunner({
        config,
        engine,
        bookRoot,
        chapter,
        chapterText: textOf,
        passId: job.stepId,
        changeId: job.changeId,
        now,
        ask,
        emit: (event) => emit(event),
      })();
      markVerdict('gate:rights', run.verdict);
      return run;
    },
    reviseText,
    usage: () => all,
    // A gate call that threw has no verdict row to be charged from, so its prompt is reported
    // with the writer's tokens: the close takes the larger of the two, and the money is counted.
    writerTokens: () => ({ in: written.in + attempted.in, out: written.out + attempted.out }),
    estimated: () => all.estimated === true,
    landedAt: () => landing,
    model: () => laneModel(),
    setPrompt: (value) => {
      sections = value.sections;
    },
  };
}
