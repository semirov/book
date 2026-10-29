/**
 * How the graph CLI prints one chapter (BOOK-185): the line, the JSON row, the money.
 *
 * The command layer decides *what* happened; this module decides how it reads. It moved out of
 * `cli.ts` when that file reached the 500-line limit, and it keeps the shapes the tests pin — a
 * chapter line names both passes, and the `--json` row carries both run ids and what the recall
 * added, because «what did recall buy» must be answerable without opening the database.
 */

import type { ExtractOutcome, RecallInfo } from './extract.ts';
import type { RunCounts } from './runs.ts';

export type Tokens = { in: number; out: number; cached: number };

/** Reject codes of one answer, counted: `QUOTE_NOT_FOUND=3 VALUE_UNPARSEABLE=1`. */
export function rejectCounts(rejects: ReadonlyArray<{ code: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reject of rejects) counts[reject.code] = (counts[reject.code] ?? 0) + 1;
  return counts;
}

export function rejectLine(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([code, n]) => `${code}=${String(n)}`).join(' ');
}

export function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** `+2/+0/+1` — what the recall added, in facts/edges/threads; `recall off` when not asked. */
export function addedLine(passes: { recall: RecallInfo }): string {
  const recall = passes.recall;
  if (recall.skipped) return 'recall off';
  return `recall +${String(recall.added.facts)}/${String(recall.added.edges)}/${String(recall.added.threads)}`;
}

/** One chapter's line: the shape the brief asks for, plus the recall and the refusal code. */
export function chapterLine(input: {
  chapter: number;
  rev: number;
  counts: RunCounts;
  rejects: number;
  usd: number;
  tokens: Tokens;
  passes: { recall: RecallInfo };
  mode: 'reused' | 'model' | 'dry';
  error?: string;
}): string {
  const line =
    `ch${String(input.chapter).padStart(2, '0')} rev ${String(input.rev)} · facts ${String(input.counts.facts)} · ` +
    `uses ${String(input.counts.uses)} · edges ${String(input.counts.edges)} · threads ${String(input.counts.threads)} · ` +
    `rejects ${String(input.rejects)} · ${addedLine(input.passes)} · ` +
    `tokens ${String(input.tokens.in)}/${String(input.tokens.out)} · ${usd(input.usd)} · ${input.mode}`;
  return input.error === undefined ? line : `${line} · refused:${input.error}`;
}

/** What a chapter produced, in the one shape the line and the JSON both print. */
export function countsOf(outcome: ExtractOutcome): RunCounts {
  if (!outcome.ok) return { facts: 0, uses: 0, edges: 0, threads: 0 };
  if (outcome.reused) return outcome.counts;
  if (outcome.dryRun) {
    return {
      facts: outcome.accepted.facts.length,
      uses: outcome.accepted.uses.length,
      edges: outcome.accepted.edges.length,
      threads: outcome.accepted.threads.length,
    };
  }
  return {
    facts: outcome.counts.facts,
    uses: outcome.counts.uses,
    edges: outcome.counts.edges,
    threads: outcome.counts.threads,
  };
}

/** How the answer was obtained: from the ledger, from the model, or not at all (a dry run). */
export function modeOf(outcome: ExtractOutcome): 'reused' | 'model' | 'dry' {
  if (!outcome.ok) return 'model';
  return outcome.reused ? 'reused' : outcome.dryRun ? 'dry' : 'model';
}

export type RunJson = {
  chapter: number;
  rev: number;
  run: string | null;
  mode: 'reused' | 'model' | 'dry';
  ok: boolean;
  error: string | null;
  facts: number;
  uses: number;
  edges: number;
  threads: number;
  rejects: number;
  rejectCodes: Record<string, number>;
  usd: number;
  /** Both passes together: the chapter's own bill. */
  tokens: Tokens;
  model: string;
  promptSha: string;
  /** The two runs of the chapter: the extract question and the recall question. */
  runs: { extract: string | null; recall: string | null };
  /** Each pass's own tokens, so a report can price them separately. */
  tokensByPass: { extract: Tokens; recall: Tokens | null };
  /** The `max_tokens` the extract request asked with (`--max-output` or the pin). */
  maxOutput: number;
  /** What the recall put into the graph that the first pass did not. */
  recallAdded: { facts: number; edges: number; threads: number };
  /** The recall run's fate: null when it was skipped. */
  recall: { ok: boolean; error: string | null; rejects: number; rejectCodes: Record<string, number>; usd: number } | null;
};
