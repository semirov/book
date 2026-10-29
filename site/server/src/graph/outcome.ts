/**
 * What one chapter's extraction answered, in the shape the CLI and the tests read (BOOK-185).
 *
 * Four outcomes — a reuse, a write, a dry run and a refusal — and each carries **both passes**:
 * the extract question and the recall question, with their own tokens, money and rejects. The
 * merged totals (`usage`, `usd`) are the chapter's own bill, which is what the CLI sums.
 *
 * These types live here, and not in `extract.ts`, because the pass's orchestrator reached the
 * 500-line limit: the module that decides *when* to ask is not the module that describes *what
 * came back*.
 */

import type { Duplicates, Reject } from './judged.ts';
import type { ModelUsage } from './model.ts';
import type { AskOutcome } from './pass.ts';
import type { PersistResult } from './persist.ts';
import type { RecallAdded } from './recall.ts';
import type { OkRun, RunCounts } from './runs.ts';
import type { ValidateResult } from './validate.ts';

/** What the run(s) that produced an answer asked and paid: the same four facts for every outcome. */
export type RunMeta = { model: string; promptSha: string; usage: ModelUsage; usd: number };

/** One pass's own account: its run row (null in a dry run), its tokens and what it refused. */
export type PassInfo = { run: string | null; usage: ModelUsage; usd: number; rejects: Reject[] };

/** The recall pass as an outcome carries it: skipped, or asked with what it bought. */
export type RecallInfo =
  | { skipped: true }
  | (PassInfo & {
      skipped: false;
      ok: boolean;
      /** `SCHEMA_INVALID`, a transport code, or null when the additions were merged. */
      code: string | null;
      added: RecallAdded;
    });

/** Both passes of one chapter, in the order they were asked. */
export type Passes = { extract: PassInfo; recall: RecallInfo };

/** The chapter's own bill: the two passes summed, which is what the CLI totals. */
export function totalMetaOf(model: string, promptSha: string, passes: Passes): RunMeta {
  const recall = passes.recall.skipped ? null : passes.recall;
  return {
    model,
    promptSha,
    usage: {
      in: passes.extract.usage.in + (recall?.usage.in ?? 0),
      out: passes.extract.usage.out + (recall?.usage.out ?? 0),
      cached: passes.extract.usage.cached + (recall?.usage.cached ?? 0),
    },
    usd: passes.extract.usd + (recall?.usd ?? 0),
  };
}

/**
 * The first answer as one run has it: a stored extract run (revalidated against the chapter as it
 * stands, so only the recall question is left to ask), or the call this run just paid for.
 */
export type FirstPass =
  | { kind: 'stored'; run: OkRun; first: ValidateResult }
  | { kind: 'asked'; answered: Extract<AskOutcome, { ok: true }>; first: ValidateResult };

export type ExtractReused = RunMeta & {
  ok: true;
  reused: true;
  chapter: number;
  rev: number;
  /** The extract run. The recall run, when there is one, is `passes.recall.run`. */
  run: string;
  counts: RunCounts;
  /** The stored run's own rejects: a reuse answers with the audit, not an empty list. */
  rejects: Reject[];
  passes: Passes;
};

export type ExtractWritten = RunMeta & {
  ok: true;
  reused: false;
  dryRun: false;
  chapter: number;
  rev: number;
  run: string;
  counts: PersistResult;
  rejects: Reject[];
  duplicates: Duplicates;
  passes: Passes;
};

export type ExtractDry = RunMeta & {
  ok: true;
  reused: false;
  dryRun: true;
  chapter: number;
  rev: number;
  run: null;
  accepted: Pick<ValidateResult, 'facts' | 'uses' | 'edges' | 'threads'>;
  rejects: Reject[];
  duplicates: Duplicates;
  passes: Passes;
};

export type ExtractRefused = RunMeta & {
  ok: false;
  reused: false;
  chapter: number;
  rev: number;
  run: string | null;
  code: string;
  rejects: Reject[];
  passes: Passes;
};

export type ExtractOutcome = ExtractReused | ExtractWritten | ExtractDry | ExtractRefused;
