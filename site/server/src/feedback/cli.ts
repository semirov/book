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
  EDIT_DAY_MS,
  holdsInternalCode,
  TOTAL_CHAPTERS,
  interventionKindLabel,
  normalizeInterventionKind,
  normalizeRetroMode,
  validateInterventionKind,
  validateIntent,
  validateReason,
  type CommentStatus,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { readCommentRow } from '../comments/repo.ts';
import { isEditExempt } from '../comments/budget.ts';
import { editIdentityKey, editIpKeyFromHash } from '../rate/policy.ts';
import { RateLimiter, type LimitSpec } from '../rate/limiter.ts';
import { acceptComment } from './accept.ts';
import {
  closeBatch,
  createBatch,
  listBatches,
  listCommentsByStatus,
  markDelivered,
  readBatch,
  readBatchLines,
} from './batches.ts';
import { appendDecision } from './decisionsFile.ts';
import { audit, heldInbox, hold, release, rights, rightsInbox } from './operator.ts';
import { settleAttempt, spendFromFlags } from './triage.ts';
import { chapterVocabulary } from './vocabulary.ts';

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
    if (name === 'help' || name === 'json' || name === 'held' || name === 'rights') {
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

const USAGE = `usage: feedback.mjs <inbox|audit|hold|rights|release|read|decide|close|list> [...]
  inbox  [--limit 20] [--chapter 8] [--held] [--rights]
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
  a filing on the frozen frame is accepted as paperwork: --mode names the document it became`;

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

function decide(parsed: ParsedArgs, io: FeedbackIo, now: () => Date): number {
  const commentId = parsed.positionals[0];
  const verdict = parsed.positionals[1];
  if (commentId === undefined || (verdict !== 'accepted' && verdict !== 'rejected')) {
    io.print('usage: feedback.mjs decide <commentId> accepted|rejected --reason "…" [--intent "…"] [--rev chNN@R]');
    return 2;
  }
  const comment = readCommentRow(io.db, commentId);
  if (comment === undefined) {
    io.print(`unknown comment: ${commentId}`);
    return 1;
  }
  if (comment.decided_at !== null) {
    io.print(`refused: ${commentId} is already decided (first decision wins)`);
    return 1;
  }
  // BOOK-158: the money of the answer, named on the command line. Read before anything is
  // written, so a bad value refuses the call instead of half-applying it.
  const spend = spendFromFlags(parsed.flags);
  if ('error' in spend) {
    io.print(`refused: ${spend.error}`);
    return 2;
  }
  // BOOK-137: the paperwork mode a filing on the frozen frame is filed as. Absent means the
  // engine's default; an unknown word is refused here, never guessed at.
  const rawMode = parsed.flags.get('mode');
  const mode = rawMode === undefined ? null : normalizeRetroMode(rawMode);
  if (rawMode !== undefined && mode === null) {
    io.print('refused: --mode must be оформление, поправка or расхождение');
    return 2;
  }
  const reason = validateReason(parsed.flags.get('reason') ?? '');
  if (!reason.ok) {
    io.print(`refused: ${reason.reason}`);
    return 1;
  }
  // BOOK-158: the decision line is the sentence the reader reads. A handle (`INTENT_SHAPE`)
  // is an operator's note, not a sentence — the line is refused rather than printed to a reader.
  if (holdsInternalCode(reason.reason)) {
    io.print('refused: --reason must be a sentence, not a code');
    return 1;
  }
  const at = now().toISOString();
  if (verdict === 'rejected') {
    io.db
      .prepare(`UPDATE comments SET status = 'rejected', decided_at = ?, reason = ? WHERE id = ?`)
      .run(at, reason.reason, comment.id);
    appendDecision(io.dir, {
      id: comment.id,
      status: 'rejected',
      reason: reason.reason,
      at,
      batch: comment.batch_id,
      changeId: null,
    });
    // BOOK-158: the refusal closes the attempt it answered and still charges the call — the
    // model was paid whether or not the reader's words were taken.
    settleAttempt(io.db, { commentId: comment.id, chapter: comment.chapter, outcome: 'refused', at, spend: spend.spend });
    io.print(`${comment.id}: rejected`);
    return 0;
  }

  // BOOK-16 — the kind stored with the comment is the one triage validates and the one the
  // change carries. A value this build does not know (a newer writer, a hand-edited row) is
  // refused with a code rather than dropped; a row stored before BOOK-16 has none and is
  // decided exactly as before.
  const kindCheck = comment.intervention_kind === null ? null : validateInterventionKind(comment.intervention_kind);
  if (kindCheck !== null && !kindCheck.ok) {
    io.print(`refused (${kindCheck.code}): ${kindCheck.reason}`);
    return 1;
  }
  const intent = validateIntent(parsed.flags.get('intent') ?? '', comment.chapter, {
    vocabulary: chapterVocabulary(io.db, comment.chapter),
    kind: kindCheck === null ? null : kindCheck.kind,
  });
  if (!intent.ok) {
    io.print(`refused (${intent.code}): ${intent.reason}`);
    return 1;
  }
  const rev = parseRev(parsed.flags.get('rev'));
  if (parsed.flags.has('rev')) {
    if (rev === null) {
      io.print('refused: --rev must look like ch08@3');
      return 1;
    }
    if (rev.chapter !== comment.chapter) {
      io.print('refused: --rev names another chapter');
      return 1;
    }
    const exists = io.db
      .prepare('SELECT 1 AS one FROM revisions WHERE chapter = ? AND rev = ?')
      .get(rev.chapter, rev.rev) as { one: number } | undefined;
    const current = io.db.prepare('SELECT rev FROM chapters WHERE n = ?').get(comment.chapter) as
      | { rev: number }
      | undefined;
    if (exists === undefined && current?.rev !== rev.rev) {
      io.print(`refused: ch${String(rev.chapter).padStart(2, '0')}@${rev.rev} is not a revision of that chapter`);
      return 1;
    }
  }
  const baseRev = rev?.rev ?? comment.base_rev ?? 0;

  // BOOK-158: acceptance is the one act that spends the day's edit (§14, BOOK-DOC-4 rule 5) —
  // for a note and an intervention alike, because a filing is a filing. Nothing is spent before
  // the change exists, and a refusal spends nothing at all. BOOK-113: an exempt identity's
  // tests cost no slot, but the comment budget still applied at posting.
  const limiter = new RateLimiter(io.db, () => now().getTime());
  const editLimit = io.editsPerDay ?? 1;
  const editBudgets: Array<{ spec: LimitSpec; budget: 'identity' | 'ip' }> = [];
  if (!isEditExempt(io.db, comment.identity_id)) {
    editBudgets.push({
      spec: { key: editIdentityKey(comment.identity_id), limit: editLimit, windowMs: EDIT_DAY_MS },
      budget: 'identity',
    });
    // The stored digest is the same `HMAC-SHA256(IP_SALT, ipKey)` the POST path used, so the
    // operator needs neither the address nor the salt to see the network budget.
    editBudgets.push({
      spec: { key: editIpKeyFromHash(comment.ip_hash), limit: editLimit, windowMs: EDIT_DAY_MS },
      budget: 'ip',
    });
  }
  for (const { spec, budget } of editBudgets) {
    const check = limiter.check(spec);
    if (!check.allowed) {
      io.print(
        budget === 'identity'
          ? `refused (EDIT_DAILY_LIMIT): у автора уже ${check.used} правок за сутки — замечание остаётся нерассмотренным`
          : `refused (EDIT_DAILY_LIMIT): с этого адреса уже была правка за сутки — замечание остаётся нерассмотренным`,
      );
      return 1;
    }
  }

  const accepted = acceptComment(io.db, {
    comment,
    intent: intent.intent,
    at,
    reason: reason.reason,
    baseRev,
    batch: comment.batch_id,
    ...(mode === null ? {} : { frameMode: mode }),
  });
  if ('error' in accepted) {
    const prefix = accepted.code === undefined ? 'refused' : `refused (${accepted.code})`;
    io.print(`${prefix}: ${accepted.error}`);
    return 1;
  }
  // The slot is taken only once the change exists: a refusal must leave the budget intact.
  // Both keys are recorded in one transaction, so a fault cannot spend one and not the other.
  if (editBudgets.length > 0) {
    const atMs = now().getTime();
    io.db.transaction(() => {
      for (const { spec } of editBudgets) limiter.record(spec.key, atMs);
    })();
  }
  // BOOK-158: the accepted attempt is closed and its model call charged, like a refusal's.
  settleAttempt(io.db, { commentId: comment.id, chapter: comment.chapter, outcome: 'accepted', at, spend: spend.spend });
  const chapter = io.db.prepare('SELECT rev, sha256 FROM chapters WHERE n = ?').get(comment.chapter) as
    | { rev: number; sha256: string }
    | undefined;
  appendDecision(io.dir, {
    id: comment.id,
    status: 'accepted',
    reason: reason.reason,
    intent: intent.intent,
    at,
    batch: comment.batch_id,
    changeId: accepted.changeId,
    rev: { chapter: comment.chapter, rev: baseRev },
    base: { sha256: chapter?.sha256 ?? '' },
    ...(mode === null ? {} : { mode }),
  });
  // BOOK-7: a second premise for the same chapter is a decision, not a second place in line.
  // BOOK-137: a filing that touched the frozen frame is paperwork — the CLI says so with the
  // same line the change and the comment carry, never «внесено».
  const linked = io.db.prepare('SELECT outcome, reason FROM changes WHERE id = ?').get(accepted.changeId) as
    | { outcome: string | null; reason: string | null }
    | undefined;
  io.print(
    accepted.superseded === true
      ? `${comment.id}: superseded — у главы уже есть замысел → ${accepted.changeId}`
      : linked?.outcome === 'registered'
        ? `${comment.id}: ${linked.reason ?? 'принято'} → ${accepted.changeId}`
        : `${comment.id}: accepted → ${accepted.changeId}`,
  );
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

function parseRev(raw: string | undefined): { chapter: number; rev: number } | null {
  if (raw === undefined) return null;
  const match = /^ch(\d{1,2})@(\d{1,6})$/u.exec(raw.trim());
  if (match === null) return null;
  const chapter = Number.parseInt(match[1] ?? '', 10);
  const rev = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) return null;
  if (!Number.isInteger(rev) || rev < 0) return null;
  return { chapter, rev };
}

function intFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
