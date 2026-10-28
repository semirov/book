/**
 * What the pass needs from the outside world, per chapter: the model calls, the stages, the
 * pre-image, the transcript and the two gates (`docs/writer-lane.md` §1–§2, §5).
 *
 * `pass.ts` decides *what happens and in which order*; this file does the talking. Everything is
 * injected, so a test drives a real pass through a fixture engine and a scripted provider.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chapterLabel, type WriterAssignment } from '@book/shared';

import { chapterPath, readChapter } from '../engine/text.ts';
import { sha256Hex } from '../util/hash.ts';
import type { EngineClient, GateAssignmentView } from './client.ts';
import type { PassEstimate } from './estimate.ts';
import { buildGatePrompt, type GateFinding, type GateRoleName, type RightsGateRun } from './gates.ts';
import { costUsd, type PipelineUsage } from './pipeline.ts';
import { buildWriterPrompt, type WriterAssignmentData } from './prompt.ts';
import type { WriteMode } from './mode.ts';
import type { PatchReceipt } from './transcript.ts';
import type { ProviderRequest, ProviderResult, WriterMessage } from './provider.ts';
import { PassRefusal, codeOf, failureOf, readerFallbacks, readerReason, reasonOf, type Failure, type ParkInput } from './reasons.ts';
import { restorePreSnapshot } from './revert.ts';
import type { CallKind, CallRecord } from './transcript.ts';
import { rightsRunner } from './rightsGate.ts';
import { writeTranscript } from './transcript.ts';
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
  return { in: total.in + usage.in, out: total.out + usage.out, cachedIn: total.cachedIn + usage.cachedIn };
}

/** The assignment as the prompt may quote it (`prompt.ts` narrows it the same way). */
export function assignmentData(assignment: WriterAssignment): WriterAssignmentData {
  if (typeof assignment.chapter !== 'number') {
    throw new PassRefusal('этот проход не про главу — его ведёт другая полоса, а не писатель');
  }
  return {
    chapter: assignment.chapter,
    pass: assignment.pass,
    intent: assignment.intent,
    interventionKind: assignment.interventionKind,
    premise: assignment.premise === null ? null : { intent: assignment.premise.intent, kind: assignment.premise.kind },
    expectation: assignment.expectation,
  };
}

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
  dataDir: string;
  engine: EngineClient;
  provider: ProviderCall;
  now: () => number;
  log: (line: string) => void;
};

export type GateRun = { revise: boolean; findings: GateFinding[] };


export type Lane = {
  emit(input: StageEmitInput): Promise<void>;
  ask(kind: CallKind, messages: WriterMessage[], purpose?: 'draft' | 'repair' | 'continue'): Promise<ProviderResult>;
  /** Park the pass: one reader's sentence, one `refused` stage; `cause` defaults to `failed`. */
  park(why: ParkInput): Promise<PassResult>;
  /** Remember a failure the pass survived: the transcript is where a survived failure is proved. */
  remember(failure: Failure | null): void;
  writeText(value: string): void;
  land(): Promise<void>;
  preSnapshot(at: number): void;
  transcript(result: PassResult): void;
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
  setPrompt(sections: number, sha256: string | null, prefixSha256: string | null): void;
  /** BOOK-173: the write mode the pass actually ran, and the patch it applied (when it did). */
  setMode(mode: WriteMode | null, patch: PatchReceipt | null): void;
  setEstimate(value: PassEstimate): void;
};

export function createLane(input: LaneInput, job: WriterAssignment, chapter: number, answered: Record<GateRoleName, boolean>): Lane {
  const { config, engine, bookRoot, now } = input;
  const sink: StageSink = { stage: (event) => engine.stage(event) };
  const calls: CallRecord[] = [];
  const written = { in: 0, out: 0 };
  let all: PipelineUsage = { in: 0, out: 0, cachedIn: 0 };
  let reported: string | null = null;
  // ADR-038 §2's honest limit: other weights are evidence, not a refusal.
  let mismatch: { declared: string; reported: string } | null = null;
  let promptSections = 0;
  let promptSha256: string | null = null;
  let promptPrefix: string | null = null;
  let mode: WriteMode | null = null;
  let patch: PatchReceipt | null = null;
  let estimate: PassEstimate | null = null;
  // The two voices of a stop: the code and its detail for the transcript, the sentence for the note.
  let failure: Failure | null = null;
  let note: string | null = null;

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
      throw new PassRefusal(reasonOf(error), codeOf(error));
    }
    // The writer's own tokens: what `done` reports — each gate's verdict row is added by the close.
    if (kind === 'draft' || kind === 'repair' || kind === 'continue') {
      written.in += result.usage.in;
      written.out += result.usage.out;
    }
    all = addUsage(all, result.usage);
    reported = result.responseModel;
    // The pin's own wire id (`apiModelOf`) is the same weights; any other id is the honest-limit
    // case below: recorded once, and the pass goes on.
    if (mismatch === null && result.responseModel !== config.model && result.responseModel !== config.apiModel) {
      mismatch = { declared: config.model, reported: result.responseModel };
    }
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    calls.push({
      kind,
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
    const sentence = readerReason(code, why.fallback ?? (code === null ? why.detail : readerFallbacks.stopped));
    failure = { code, detail: why.detail };
    note = sentence;
    input.log(`[writer] parked ${code ?? 'без кода'}: ${why.detail.slice(0, 300)}`);
    // BOOK-117: a parked pass spent money too — the writer's own calls travel with the escalate, and
    // each gate's verdict row is added by the close. A park before the first call claims neither.
    const spent = calls.length === 0
      ? { tokensIn: 0, tokensOut: 0 }
      : { model: config.model, tokensIn: written.in, tokensOut: written.out };
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
    return {
      status: 'parked',
      stepId: job.stepId,
      changeId: job.changeId,
      ...(why.cause === 'refused' ? { filingRefused: true } : {}),
      // The reader's sentence, not the code word (the code lives in the log and transcript).
      reason: sentence,
      tokens: { ...written },
      costUsd: costUsd(config.pipeline.pricing, all),
    };
  }

  /** `land`: a `STEP_CLOSED` or `FRAME_CHANGED` answer takes the text back (BOOK-137). */
  async function land(): Promise<void> {
    try {
      await engine.land(job.leaseId);
    } catch (error) {
      const code = codeOf(error);
      const back =
        code === 'STEP_CLOSED' || code === 'FRAME_CHANGED'
          ? restorePreSnapshot(input.dataDir, bookRoot, chapter)
          : null;
      if (back) input.log(`[writer] land ${code ?? 'refused'}: снимок до прохода ${back.restored ? 'возвращён' : 'не найден'}`);
      throw new PassRefusal(reasonOf(error), codeOf(error));
    }
  }

  /** Atomic: a reader never sees half a chapter, and `land` reads a whole file. */
  function writeText(value: string): void {
    const target = chapterPath(bookRoot, chapter);
    const staging = `${target}.tmp`;
    writeFileSync(staging, value, 'utf8');
    renameSync(staging, target);
  }

  /** The pre-image, before the writer touches anything: what a revert puts back. */
  function preSnapshot(at: number): void {
    const dir = join(input.dataDir, 'writer', 'pre');
    mkdirSync(dir, { recursive: true });
    const current = readChapter(bookRoot, chapter);
    const stamp = {
      chapter,
      state: current.exists ? 'present' : 'absent',
      sha: current.exists ? sha256Hex(current.raw) : null,
      at,
    };
    if (current.exists) writeFileSync(join(dir, `ch${chapterLabel(chapter)}.md`), current.raw, 'utf8');
    writeFileSync(join(dir, `ch${chapterLabel(chapter)}.json`), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
  }

  /** Evidence, not the pass: requests and answers, hashes instead of a second copy of the canon. */
  function transcript(result: PassResult): void {
    try {
      writeTranscript(input.dataDir, job.stepId, {
        chapter, at: now(), model: config.model, apiModel: config.apiModel,
        reportedModel: reported, modelMismatch: mismatch, promptSha256,
        cachePrefix: promptPrefix, mode, patch,
        sections: promptSections, estimate, note, failure,
        result: { status: result.status, reason: result.reason ?? null },
        calls,
      });
    } catch {
      input.log('[writer] transcript not written');
    }
  }

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
          landedText: readChapter(bookRoot, chapter).text,
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
    // A revision is a whole chapter, whatever the filing said: the mode follows the text.
    mode = 'rewrite';
    const rebuilt = buildWriterPrompt({ bookRoot, assignment: assignmentData(job) });
    const revised = await reviseAnswer({
      rebuilt,
      findings,
      ask: (messages) => ask('repair', messages, 'repair'),
      check,
      log: input.log,
    });
    if (revised === null) return null;
    writeText(revised);
    await land();
    return revised;
  }

  return {
    emit,
    ask,
    park,
    remember: (value) => {
      if (value !== null) failure = value;
    },
    writeText,
    land,
    preSnapshot,
    transcript,
    check,
    runGate: (role) => runGate(role),
    runRightsGate: rightsRunner({
      config,
      engine,
      bookRoot,
      chapter,
      passId: job.stepId,
      changeId: job.changeId,
      now,
      ask,
      emit: (event) => emit(event),
    }),
    reviseText,
    usage: () => all,
    writerTokens: () => ({ ...written }),
    model: () => laneModel(),
    setPrompt: (sections, sha, prefix) => {
      promptSections = sections;
      promptSha256 = sha;
      promptPrefix = prefix;
    },
    setMode: (nextMode, nextPatch) => {
      mode = nextMode;
      patch = nextPatch;
    },
    setEstimate: (value) => {
      estimate = value;
    },
  };
}
