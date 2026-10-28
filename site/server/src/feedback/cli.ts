#!/usr/bin/env node
/**
 * The host-side triage CLI (ARCHITECTURE.md §12.6) — `feedback.mjs`.
 *
 * It runs on the host, opens the same SQLite file, reads comments as data and writes the
 * file exchange (`batches/*.jsonl`, `decisions.jsonl`). It never calls a model, never
 * writes prose and never touches the manuscript.
 *
 *   feedback.mjs inbox  [--limit 20] [--chapter 8] [--held] [--rights]
 *   feedback.mjs audit  <commentId> --verdict FITS|OFF --reason "…" [--by label]
 *   feedback.mjs audit  <commentId> --answer <json | @file | ->
 *   feedback.mjs hold   <commentId> --rule <INJ-…> --evidence <field>:<quote> [--by label]
 *   feedback.mjs release <commentId> --reason "…" [--by label]
 *   feedback.mjs read   <batchId>
 *   feedback.mjs decide <commentId> accepted --reason "…" --intent "…" [--rev chNN@R] [--mode …]
 *   feedback.mjs decide <commentId> rejected --reason "…"
 *   feedback.mjs close  <batchId>
 *   feedback.mjs list   [--status new] [--limit 50]
 *
 * Every comment is audited (`audit`, BOOK-9) before it can be decided: the auditor judges
 * whether the intervention fits the book's canvas — `process/ROLE_PROMPTS.md` §0 is the
 * brief, and this CLI only records its verdict. `FITS` permits a later `decide`; `OFF`
 * refuses the comment to the reader, with the auditor's reason, in the same act.
 *
 * BOOK-61 adds Gate A's two operator acts: `hold` is the A pass's write (a stopped filing
 * becomes `quarantined` with the rule that stopped it, and the evidence passes the same
 * post-check a model's verdict does); `release` is the operator's undo (HELD → `new`).
 *
 * Gate B's surface is here too: `rights` records the gate's rule-bound verdict, `inbox
 * --rights` lists flagged rows, and `release` lifts a `RIGHTS-QUOTE` refusal (not a stop one).
 *
 * The core is here, not in `bin/`, so the rules are unit-tested with a real database; the
 * `bin/feedback.mjs` wrapper only resolves paths and the exit code.
 */


import {
  TOTAL_CHAPTERS,
  interventionKindLabel,
  normalizeInterventionKind,
  type CommentStatus,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { escalatedInbox } from './author.ts';
import {
  closeBatch,
  createBatch,
  listBatches,
  listCommentsByStatus,
  markDelivered,
  readBatch,
  readBatchLines,
} from './batches.ts';
import { decide } from './decide.ts';
import { dispositionLimitLines, readDispositionCounts, refreshDispositionCounts } from './dispositionCounts.ts';
import { audit } from './auditCli.ts';
import { heldInbox, hold, release, rights, rightsInbox } from './operator.ts';

export type FeedbackIo = {
  db: Db;
  dir: string;
  now?: () => Date;
  print: (line: string) => void;
  /** SPEC «Load & network»: one reader edit per day, per identity and per network. */
  editsPerDay?: number;
};

export type ParsedArgs = {
  command: string | null;
  positionals: string[];
  flags: Map<string, string>;
};

export function parseFeedbackArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'help' || name === 'json' || name === 'held' || name === 'rights' || name === 'escalated') {
      flags.set(name, 'true');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`flag --${name} needs a value`);
    flags.set(name, value);
    index += 1;
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

const USAGE = `usage: feedback.mjs <inbox|audit|hold|rights|release|read|decide|close|list|limits> [...]
  inbox  [--limit 20] [--chapter 8] [--held] [--rights] [--escalated]
  audit  <commentId> --verdict FITS|OFF --reason "…" [--by label]
  audit  <commentId> --answer <json | @file | ->
  hold   <commentId> --rule <INJ-…> --evidence <field>:<quote> [--by label]
  rights <commentId> --verdict CLEAR|REFUSED --rule <id> [--source "…"] [--by label]
  rights <commentId> --answer <json | @file | ->
  release <commentId> --reason "…" [--by label]
  read   <batchId>
  decide <commentId> accepted --reason "…" --intent "…" [--rev chNN@R] [--mode оформление|поправка|расхождение]
  decide <commentId> rejected --reason "…"
  close  <batchId>
  list   [--status new] [--limit 50]
  limits            the editor's check: отказа в мире больше 1 в 4 · 1 в 6 · 0 в части
  a filing on the frozen frame is accepted as paperwork: --mode names the document it became
  a rejected filing is escalated to the author unless a lock (право, безопасность, рамка, финал) applies`;

export function runFeedback(argv: string[], io: FeedbackIo): number {
  const now = io.now ?? (() => new Date());
  let parsed: ParsedArgs;
  try {
    parsed = parseFeedbackArgs(argv);
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error));
    io.print(USAGE);
    return 2;
  }
  if (parsed.command === null || parsed.flags.has('help')) {
    io.print(USAGE);
    return parsed.command === null ? 2 : 0;
  }

  try {
    switch (parsed.command) {
      case 'inbox':
        return inbox(parsed, io, now);
      case 'audit':
        return audit(parsed, io, now);
      case 'hold':
        return hold(parsed, io, now);
      case 'rights':
        return rights(parsed, io, now);
      case 'release':
        return release(parsed, io, now);
      case 'read':
        return read(parsed, io);
      case 'decide':
        return decide(parsed, io, now);
      case 'close':
        return close(parsed, io, now);
      case 'list':
        return list(parsed, io);
      case 'limits':
        return limits(io, now);
      default:
        io.print(`unknown command: ${parsed.command}`);
        io.print(USAGE);
        return 2;
    }
  } catch (error) {
    io.print(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function inbox(parsed: ParsedArgs, io: FeedbackIo, now: () => Date): number {
  if (parsed.flags.has('held')) return heldInbox(parsed, io);
  if (parsed.flags.has('escalated')) return escalatedInbox(parsed, io);
  if (parsed.flags.has('rights')) return rightsInbox(parsed, io);
  const limit = intFlag(parsed.flags.get('limit'), 20);
  let chapter: number | undefined;
  if (parsed.flags.has('chapter')) {
    const raw = Number.parseInt(parsed.flags.get('chapter') ?? '', 10);
    if (!Number.isInteger(raw) || raw < 1 || raw > TOTAL_CHAPTERS) {
      io.print(`refused: --chapter must be 1..${TOTAL_CHAPTERS}`);
      return 2;
    }
    chapter = raw;
  }
  const result = createBatch({ db: io.db, dir: io.dir, now }, { limit, chapter });
  if ('error' in result) {
    io.print(result.error);
    return 1;
  }
  io.print(`batch ${result.batchId} → ${result.path}`);
  // BOOK-16: each item is named with the kind it declares — the auditor judges the
  // intervention as that world-fact, and `—` means a row stored before BOOK-16. BOOK-61: the
  // batch file holds envelopes, so the id printed here is the envelope's `itemId`.
  const items = readBatchLines(io.dir, result.batchId);
  for (const item of items) {
    io.print(`  ${item.itemId}  ${interventionKindLabel(normalizeInterventionKind(item.kind)) ?? '—'}`);
  }
  io.print('  каждое замечание сначала проходит audit (FITS|OFF): без FITS decide откажет');
  return 0;
}

function read(parsed: ParsedArgs, io: FeedbackIo): number {
  const batchId = parsed.positionals[0];
  if (batchId === undefined) {
    io.print('usage: feedback.mjs read <batchId>');
    return 2;
  }
  if (readBatch(io.db, batchId) === undefined) {
    io.print(`unknown batch: ${batchId}`);
    return 1;
  }
  const items = readBatchLines(io.dir, batchId);
  const count = markDelivered(io.db, batchId);
  io.print(`${batchId}: ${count} delivered (${items.length} in the file)`);
  return 0;
}

function close(parsed: ParsedArgs, io: FeedbackIo, now: () => Date): number {
  const batchId = parsed.positionals[0];
  if (batchId === undefined) {
    io.print('usage: feedback.mjs close <batchId>');
    return 2;
  }
  if (readBatch(io.db, batchId) === undefined) {
    io.print(`unknown batch: ${batchId}`);
    return 1;
  }
  closeBatch(io.db, batchId, now().toISOString());
  io.print(`${batchId}: closed`);
  return 0;
}

/**
 * `limits` — the editor's check on how often the world refuses (BOOK-174 §7): one line per
 * part or chapter with a breach, `ok` when there is none. Operator only: the counters are
 * recomputed here from `comments` and never travel to a reader surface.
 */
function limits(io: FeedbackIo, now: () => Date): number {
  refreshDispositionCounts(io.db, now().toISOString());
  for (const line of dispositionLimitLines(readDispositionCounts(io.db))) io.print(line);
  return 0;
}

function list(parsed: ParsedArgs, io: FeedbackIo): number {
  const status = parsed.flags.get('status') as CommentStatus | undefined;
  const limit = intFlag(parsed.flags.get('limit'), 50);
  const rows = listCommentsByStatus(io.db, status, limit);
  if (rows.length === 0) {
    io.print('no comments');
    return 0;
  }
  for (const row of rows) {
    io.print(
      `${row.id}  ch${String(row.chapter).padStart(2, '0')}  ${row.status.padEnd(11)}  ` +
        `${(interventionKindLabel(row.intervention_kind) ?? '—').padEnd(14)}  ${row.author}  ${row.created_at}`,
    );
  }
  const batches = listBatches(io.db, 5);
  for (const batch of batches) io.print(`batch ${batch.id}  ${batch.count}  ${batch.closed_at ?? 'open'}`);
  return 0;
}

function intFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
