/**
 * The pass's two prose gates and its revision (`docs/writer-lane.md` §1, §5, BOOK-DOC-80).
 *
 * `passLane.ts` owns the talking; this module owns one gate as a step: the dispatch, the prompt,
 * the answer, the verdict, and the one revision a pass may take. It lives apart because
 * `passLane.ts` is at the arch bound and the gate is a rule with its own tests.
 *
 * Everything is injected — the ask, the stage sink, the text lookup and the landing — so the gate
 * runner holds no state of its own and a test can drive it without a lane.
 */

import { readFileSync } from 'node:fs';

import type { WriterAssignment } from '@book/shared';

import type { GateAssignmentView, LandView } from './client.ts';
import type { WriterConfig } from './config.ts';
import { buildGatePrompt, type GateFinding, type GateRoleName } from './gates.ts';
import { assignmentData } from './laneText.ts';
import type { Answer, GateRun } from './laneTypes.ts';
import { buildWriterPrompt, chapterQuote, type ChapterTextLookup } from './prompt.ts';
import type { ProviderResult, WriterMessage } from './provider.ts';
import { PassRefusal, codeOf, reasonOf } from './reasons.ts';
import { stageSummary, type StageEmitInput } from './stages.ts';
import { askGateAnswer } from './gateAnswer.ts';
import { rightsRunner } from './rightsGate.ts';
import { reviseAnswer } from './answer.ts';
import type { CallKind, CallVerdict } from './transcript.ts';
import type { EngineClient } from './client.ts';

/** What the gate runner may do to the lane it serves. */
export type GateDeps = {
  ask(kind: CallKind, messages: WriterMessage[]): Promise<ProviderResult>;
  emit(input: StageEmitInput): Promise<void>;
  loadText(chapters: number[]): Promise<void>;
  textOf: ChapterTextLookup;
  land(value: string): Promise<LandView | null>;
  check(value: string, finishReason?: string | null): Answer;
  /** The lane's own verdict mark on the call that produced a verdict. */
  markVerdict(kind: CallKind, verdict: CallVerdict | null): void;
};

export type GateInput = {
  deps: GateDeps;
  config: WriterConfig;
  engine: EngineClient;
  bookRoot: string;
  chapter: number;
  job: WriterAssignment;
  /** The engine's own per-role record: a role it already holds a verdict for is not asked again. */
  answered: Record<GateRoleName, boolean>;
  now: () => number;
  log: (line: string) => void;
};

export type Gates = {
  runGate(role: GateRoleName, refusal?: string | null): Promise<GateRun>;
  runRightsGate(): Promise<{ verdict: 'CLEAR' | 'REFUSED' | null; closed: boolean }>;
  reviseText(findings: GateFinding[]): Promise<string | null>;
};

/** The index slice is a path the engine returned; a missing file is not a gate failure. */
function sliceText(path: string | null): string | null {
  if (path === null || path.length === 0) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function createGates(input: GateInput): Gates {
  const { deps, config, engine, bookRoot, chapter, job, answered } = input;

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
    await deps.loadText([chapter]);
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
          landedText: chapterQuote(deps.textOf(chapter)),
          chapterText: deps.textOf,
          // BOOK-173 §7: the dispatched gate judges the text against the plan the engine froze.
          plan: gate.plan,
          indexSlice: role === 'editor' ? sliceText(gate.indexSlice) : null,
          refusal: hint,
        }),
      ask: (messages) => deps.ask(role === 'editor' ? 'gate:editor' : 'gate:consultant', messages),
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
    deps.markVerdict(role === 'editor' ? 'gate:editor' : 'gate:consultant', parsed.verdict);
    await deps.emit({
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
      at: input.now(),
    });
    return { revise: action === 'revise', findings: parsed.findings };
  }

  /** One revision of the landed text, with the findings as data. Throws on a model/engine failure. */
  async function reviseText(findings: GateFinding[]): Promise<string | null> {
    await deps.loadText([chapter - 1, chapter, chapter + 1]);
    const rebuilt = buildWriterPrompt({ bookRoot, assignment: assignmentData(job), chapterText: deps.textOf });
    const revised = await reviseAnswer({
      rebuilt,
      findings,
      ask: (messages) => deps.ask('repair', messages),
      check: deps.check,
      log: input.log,
    });
    if (revised === null) return null;
    await deps.land(revised);
    return revised;
  }

  return {
    runGate,
    reviseText,
    runRightsGate: async () => {
      const run = await rightsRunner({
        config,
        engine,
        bookRoot,
        chapter,
        chapterText: deps.textOf,
        passId: job.stepId,
        changeId: job.changeId,
        now: input.now,
        ask: (kind, messages) => deps.ask(kind, messages),
        emit: (event) => deps.emit(event),
      })();
      deps.markVerdict('gate:rights', run.verdict);
      return run;
    },
  };
}
