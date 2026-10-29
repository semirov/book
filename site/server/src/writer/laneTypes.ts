/**
 * The pass's shape (`passLane.ts`), in one place: the result a pass returns, what a lane may do,
 * and what it is given.
 *
 * They live apart from `passLane.ts` because that file is the pass's *talking* and was at the
 * file-size wall; every consumer that only needs the contract (`pass.ts`, `writePhase.ts`,
 * `verify/*`, the tests) reads it here. `passLane.ts` re-exports them, so its own public surface
 * did not move.
 */

import type { SentencePatchEdit } from '../sentences/transform.ts';
import type { EngineClient, LandView } from './client.ts';
import type { PassEstimate } from './estimate.ts';
import type { GateFinding, GateRoleName, RightsGateRun } from './gates.ts';
import type { WriteMode } from './mode.ts';
import type { PipelineUsage } from './pipeline.ts';
import type { ChapterTextLookup } from './prompt.ts';
import type { ProviderRequest, ProviderResult, WriterMessage } from './provider.ts';
import type { Failure, ParkInput } from './reasons.ts';
import type { CallKind, PatchReceipt, PromptSectionFact } from './transcript.ts';
import type { GatesRecord } from './verify/run.ts';
import type { StageEmitInput } from './stages.ts';
import type { ValidatedAnswer, AnswerRefusal } from './validate.ts';
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
  /** The closed code behind a stop, for the caller that journals it (BOOK-173); never in a note. */
  code?: string;
};

export type ProviderCall = (request: ProviderRequest) => Promise<ProviderResult>;

/** What `validateAnswer` answered: the prose or the closed refusal. */
export type Answer = ValidatedAnswer | AnswerRefusal;

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

/** A call's own bound: Tier 1 is a small question and says so (`TIER1_MAX_TOKENS`). */
export type AskOptions = { maxTokens?: number };

export type Lane = {
  emit(input: StageEmitInput): Promise<void>;
  ask(
    kind: CallKind,
    messages: WriterMessage[],
    purpose?: 'draft' | 'repair' | 'continue',
    options?: AskOptions,
  ): Promise<ProviderResult>;
  /** Park the pass: one reader's sentence, one `refused` stage; `cause` defaults to `failed`. */
  park(why: ParkInput): Promise<PassResult>;
  /** Remember a failure the pass survived: the transcript is where a survived failure is proved. */
  remember(failure: Failure | null): void;
  /** Load the rows a prompt will quote; a failed read is the caller's `park`, never a silent empty. */
  loadText(chapters: number[]): Promise<void>;
  /** The cached view of one chapter — `noChapterText` for anything not loaded. */
  textOf: ChapterTextLookup;
  /**
   * The one way the pass's text becomes a fact: the request body carries it, no file (BOOK-187).
   * The answer is the landing, because BOOK-173 §7 hands the frozen plan back to the pass; a
   * landing whose answer was lost (`null`) is still this pass's text — the rows said so (BOOK-219).
   */
  land(value: string): Promise<LandView | null>;
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
  /**
   * The prompt's sections, as facts: ids, hashes and lengths — never the prompt itself. The prefix
   * sha is BOOK-173 §5's cache identity: the number the writer and both gates share.
   */
  setPrompt(value: { sections: PromptSectionFact[]; promptSha256: string; prefixSha256: string }): void;
  /**
   * BOOK-173 §2/§4: the mode the pass ran, the patch it applied and the character edits that keep
   * sentence ids. Every call clears `sentences` — no attempt inherits the previous one's edits.
   */
  setMode(mode: WriteMode | null, patch: PatchReceipt | null, sentences?: ReadonlyArray<SentencePatchEdit> | null): void;
  /** BOOK-173 §4: the mode this pass wrote in; null before `setMode` and on a resume. */
  mode(): WriteMode | null;
  setEstimate(value: PassEstimate): void;
  /** BOOK-DOC-80: the gates record — the receipt carries it and the close writes it down. */
  setGates(value: GatesRecord): void;
  /** BOOK-219: some call's usage was read off the text — the close and the park name the estimate. */
  estimated(): boolean;
  /** The revision the pass's own last landing published, `null` before it landed anything. */
  landedAt(): { rev: number; sha: string } | null;
};
