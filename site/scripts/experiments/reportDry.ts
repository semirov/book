/**
 * The research answer on disk, without a model: one row per filing, its whole-book closure.
 *
 * Written by `--dry` to `summary-dry.md` — and to `summary.md` only while no measured summary
 * exists, because a dry run may never overwrite a measured table.
 */

import { existsSync, writeFileSync } from 'node:fs';

import { artifactPath } from './store.ts';
import type { LedgerFacts, PinFacts } from './report.ts';

export type DryClosureRow = {
  filing: string;
  chapter: number;
  outcome: string;
  anchorBlocks: number;
  seeds: number;
  nodes: number;
  edges: number;
  chapters: number;
  chaptersTouched: number[];
  mandatory: number;
  optional: number;
  longestPath: number;
  walkMs: number;
  proven: boolean;
  note: string;
};

/**
 * The research answer, written even when **zero** calls are made.
 *
 * `--dry` builds the scratch ledger, backfills it over the real manuscript and prints each filing's
 * closure — and the orchestrator must be able to read that without a run of the model. So it is
 * written to `summary-dry.md`, and to `summary.md` only while no measured summary exists yet: a dry
 * run may never overwrite a measured table.
 */
export function writeDrySummary(input: {
  pin: PinFacts;
  ledger: LedgerFacts;
  rows: DryClosureRow[];
  startedAt: string;
}): string {
  const lines = [
    '# BOOK-173 — closures, zero model calls (`--dry`)',
    '',
    `pin: \`${input.pin.model}\` (\`${input.pin.apiModel}\`) · ${input.pin.endpoint}`,
    `ledger: ${String(input.ledger.chapters)} chapters projected · ${String(input.ledger.facts)} facts · ${String(
      input.ledger.edges,
    )} edges · backfilled in ${String(input.ledger.backfillMs)} ms (\`:memory:\`, whole book, no chapter window)`,
    `at: ${input.startedAt} · network calls: 0`,
    '',
    '## closure',
    '',
    '| Filing | outcome | anchor blocks | seeds | closure (nodes/edges/ch) | chapters touched | mandatory | optional | longest | walk ms | proven | note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...input.rows.map(
      (row) =>
        `| ${row.filing} | ${row.outcome} | ${String(row.anchorBlocks)} | ${String(row.seeds)} | ${String(row.nodes)}/${String(
          row.edges,
        )}/${String(row.chapters)} | [${row.chaptersTouched.join(', ')}] | ${String(row.mandatory)} | ${String(
          row.optional,
        )} | ${String(row.longestPath)} | ${String(row.walkMs)} | ${row.proven ? 'proven' : 'unproven'} | ${row.note} |`,
    ),
    '',
    '`seeds` is how many facts the filing\'s anchor paragraph asserts; `0` means the ledger cannot name',
    'what the filing changes (`unproven`), which is a result about the graph, not about the prose.',
    'A closure with `mandatory 0` is a point patch and nothing else.',
    '',
  ];
  const target = artifactPath('summary-dry.md');
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  const measured = artifactPath('summary.json');
  if (!existsSync(measured)) writeFileSync(artifactPath('summary.md'), `${lines.join('\n')}\n`, 'utf8');
  return target;
}
