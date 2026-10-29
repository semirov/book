/**
 * Gate B in the lane (BOOK-61, BOOK-DOC-42, the owner's rule of 2026-10-28).
 *
 * Every prose pass carries a rights answer; two different jobs share the one record:
 *
 *   • the scan came back **clean** — the answer is mechanical. No model is called, `CLEAR` is
 *     submitted with zero tokens, and the stage says so («скан чистый, модель не звана»): the
 *     record must show the question was answered, not skipped.
 *   • the scan came back **flagged** — the copyright question is asked, with the scanner's rule
 *     and block as data. A `REFUSED` closes the step at once (the engine does it), and the pass
 *     ends there: a refusal is a decision about the text.
 *
 * The question is about rights, never taste: the text is machine-written from this book's own
 * canon, so «ours» is the canon, the forms and the characters' own lines, and what must be
 * refused is third-party text — a quotation without a source, lyrics, a translated passage, a
 * real person or somebody else's hero, or anything the law stops.
 */

import type { WriterConfig } from './config.ts';
import type { EngineClient, RightsAssignmentView } from './client.ts';
import { parseRightsAnswer, type RightsGateRun } from './gates.ts';
import { buildRightsPrompt } from './gates.ts';
import type { ProviderResult } from './provider.ts';
import { stageSummary } from './stages.ts';
import { costUsd, type PipelineUsage } from './pipeline.ts';
import type { PassResult } from './passLane.ts';
import { chapterQuote, type ChapterTextLookup } from './prompt.ts';

export type RightsRunDeps = {
  config: WriterConfig;
  engine: EngineClient;
  bookRoot: string;
  chapter: number;
  /** The chapter's landed text, from rows only (BOOK-187): the gate judges what the site serves. */
  chapterText: ChapterTextLookup;
  passId: string;
  changeId: string | null;
  now: () => number;
  /** The provider, as the lane calls it (`kind` is the call's label in the transcript). */
  ask: (kind: 'gate:rights', messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<ProviderResult>;
  /** A stage that cannot be written is logged, never fatal: the verdict is the pass's fact. */
  emit: (event: {
    stage: 'verdict';
    chapter: number;
    passId: string;
    changeId: string | null;
    summary: string;
    model: string | null;
    at: number;
  }) => Promise<void>;
};

/**
 * The lane's `runRightsGate`, as a factory so `passLane.ts` stays the pass and not the gate: a
 * failure inside is the pass's failure with its own code, never a bare `Error`.
 */
export function rightsRunner(deps: RightsRunDeps): () => Promise<RightsGateRun> {
  return async () => {
    try {
      return await runRightsGate(deps);
    } catch (error) {
      if (error instanceof RightsGateMissing || error instanceof RightsGateUnparsed) throw error;
      const code = (error as { code?: string }).code ?? null;
      throw new RightsGateFailed(code, error instanceof Error ? error.message : String(error));
    }
  };
}

/** A rights answer could not be obtained or recorded: the step cannot close without it. */
export class RightsGateFailed extends Error {
  readonly code: string | null;
  constructor(code: string | null, message: string) {
    super(message.slice(0, 300));
    this.name = 'RightsGateFailed';
    this.code = code;
  }
}

/** The lane's `runRightsGate`, as a factory so `passLane.ts` stays the pass and not the gate. */
export async function runRightsGate(deps: RightsRunDeps): Promise<RightsGateRun> {
  const { config, engine, chapter, passId, changeId, now } = deps;
  let gate: RightsAssignmentView | null;
  try {
    gate = await engine.nextRightsGate(config.session);
  } catch (error) {
    throw error;
  }
  if (gate === null) {
    // A prose step the engine will not close without a rights answer, and no dispatch offered:
    // the engine and the lane disagree about the contract, and closing blind is not an option.
    throw new RightsGateMissing();
  }

  if (gate.rule === null) {
    const answer = await engine.verdictRights({
      stepId: gate.stepId,
      role: 'rights',
      session: gate.session,
      verdict: 'CLEAR',
      rule: null,
      model: config.model,
      tokensIn: 0,
      tokensOut: 0,
    });
    await deps.emit({
      stage: 'verdict',
      chapter,
      passId,
      changeId,
      summary: stageSummary.rightsVerdict({ verdict: 'CLEAR', rule: null, scanned: false }),
      model: null,
      at: now(),
    });
    return { closed: answer.closed, verdict: 'CLEAR' };
  }

  // BOOK-DOC-84 D3: Gate B's model call gets the same start row as the other two gates.
  await deps.emit({
    stage: 'verdict',
    chapter,
    passId,
    changeId,
    summary: stageSummary.verdictStarted({ role: 'rights' }),
    model: config.model,
    at: now(),
  });
  const prompt = buildRightsPrompt({
    bookRoot: deps.bookRoot,
    chapter,
    landedText: chapterQuote(deps.chapterText(chapter)),
    scan: { rule: gate.rule, block: gate.block },
  });
  const answer = await deps.ask('gate:rights', [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]);
  const parsed = parseRightsAnswer(answer.text);
  if (!parsed.ok) throw new RightsGateUnparsed(parsed.reason);
  const result = await engine.verdictRights({
    stepId: gate.stepId,
    role: 'rights',
    session: gate.session,
    verdict: parsed.verdict,
    rule: parsed.rule,
    model: config.model,
    tokensIn: answer.usage.in,
    tokensOut: answer.usage.out,
  });
  await deps.emit({
    stage: 'verdict',
    chapter,
    passId,
    changeId,
    summary: stageSummary.rightsVerdict({ verdict: parsed.verdict, rule: parsed.rule, scanned: true }),
    model: config.model,
    at: now(),
  });
  return { closed: result.closed, verdict: parsed.verdict };
}

/** No dispatch for a step that cannot close without one — an engine/lane contract break. */
export class RightsGateMissing extends Error {
  readonly code = 'RIGHTS_REQUIRED';
  constructor() {
    super('гейт прав не выдал задание — проход нельзя закрыть без ответа');
    this.name = 'RightsGateMissing';
  }
}

/** Gate B's answer did not parse: never a default `CLEAR`, never a default `REFUSED`. */
export class RightsGateUnparsed extends Error {
  readonly code = 'GATE_UNPARSED';
  constructor(reason: string) {
    super(`GATE_UNPARSED: ${reason}`.slice(0, 300));
    this.name = 'RightsGateUnparsed';
  }
}

/**
 * The pass's end when Gate B refused: the engine already closed the step (`escalated:rights`),
 * so the lane reports the refusal with the pass's own money and writes no `done`. The sentence
 * says what happened to the text — the caller names it, because the pass takes its own landing
 * back before it answers (BOOK-219).
 */
export function rightsRefusal(input: {
  stepId: string;
  changeId: string | null;
  lane: { writerTokens(): { in: number; out: number }; usage(): PipelineUsage };
  config: WriterConfig;
  sentence: string;
}): PassResult {
  return {
    status: 'parked',
    stepId: input.stepId,
    changeId: input.changeId,
    reason: input.sentence,
    tokens: input.lane.writerTokens(),
    costUsd: costUsd(input.config.pipeline.pricing, input.lane.usage()),
  };
}
