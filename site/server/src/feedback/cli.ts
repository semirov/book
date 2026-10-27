#!/usr/bin/env node
/**
 * The host-side triage CLI (ARCHITECTURE.md §12.6) — `feedback.mjs`.
 *
 * It runs on the host, opens the same SQLite file, reads comments as data and writes the
 * file exchange (`batches/*.jsonl`, `decisions.jsonl`). It never calls a model, never
 * writes prose and never touches the manuscript.
 *
 *   feedback.mjs inbox  [--limit 20] [--chapter 8]
 *   feedback.mjs audit  <commentId> --verdict FITS|OFF --reason "…" [--by label]
 *   feedback.mjs read   <batchId>
 *   feedback.mjs decide <commentId> accepted --reason "…" --intent "…" [--rev chNN@R]
 *   feedback.mjs decide <commentId> rejected --reason "…"
 *   feedback.mjs close  <batchId>
 *   feedback.mjs list   [--status new] [--limit 50]
 *
 * Every comment is audited (`audit`, BOOK-9) before it can be decided: the auditor judges
 * whether the intervention fits the book's canvas — `process/ROLE_PROMPTS.md` §0 is the
 * brief, and this CLI only records its verdict. `FITS` permits a later `decide`; `OFF`
 * refuses the comment to the reader, with the auditor's reason, in the same act.
 *
 * The core is here, not in `bin/`, so the rules are unit-tested with a real database; the
 * `bin/feedback.mjs` wrapper only resolves paths and the exit code.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  COMMENT_AUDITED_BY_MAX_CHARS,
  EDIT_DAY_MS,
  interventionKindLabel,
  validateInterventionKind,
  validateIntent,
  validateReason,
  type CommentStatus,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { readCommentRow } from '../comments/repo.ts';
import { editIdentityKey, editIpKeyFromHash } from '../rate/policy.ts';
import { RateLimiter, type LimitSpec } from '../rate/limiter.ts';
import { acceptComment } from './accept.ts';
import { recordAudit } from './audit.ts';
import {
  closeBatch,
  createBatch,
  listBatches,
  listCommentsByStatus,
  markDelivered,
  readBatch,
  readBatchLines,
} from './batches.ts';
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
    if (name === 'help' || name === 'json') {
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

const USAGE = `usage: feedback.mjs <inbox|audit|read|decide|close|list> [...]
  inbox  [--limit 20] [--chapter 8]
  audit  <commentId> --verdict FITS|OFF --reason "…" [--by label]
  read   <batchId>
  decide <commentId> accepted --reason "…" --intent "…" [--rev chNN@R]
  decide <commentId> rejected --reason "…"
  close  <batchId>
  list   [--status new] [--limit 50]`;

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
  const limit = intFlag(parsed.flags.get('limit'), 20);
  let chapter: number | undefined;
  if (parsed.flags.has('chapter')) {
    const raw = Number.parseInt(parsed.flags.get('chapter') ?? '', 10);
    if (!Number.isInteger(raw) || raw < 1 || raw > 67) {
      io.print('refused: --chapter must be 1..67');
      return 2;
    }
    if (raw === 67) {
      io.print('refused: глава 67 заморожена — замечания к ней не становятся правками (ENDING_FROZEN)');
      return 1;
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
  // intervention as that world-fact, and `—` means a row stored before BOOK-16. The labels
  // come from the batch file that was just written (one read, not a query per item).
  const items = readBatchLines(io.dir, result.batchId);
  for (const item of items) {
    io.print(`  ${item.id}  ${interventionKindLabel(item.kind) ?? '—'}`);
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
 * `audit <commentId> --verdict FITS|OFF --reason "…" [--by label]` (BOOK-9).
 *
 * The verdict is recorded once, before triage. `OFF` is also the refusal: the comment becomes
 * `rejected` with the auditor's plain reason and a decision line, exactly like any other
 * refusal, and no change exists. `FITS` only permits a later `decide`.
 */
function audit(parsed: ParsedArgs, io: FeedbackIo, now: () => Date): number {
  const commentId = parsed.positionals[0];
  const verdict = parsed.flags.get('verdict');
  if (commentId === undefined || (verdict !== 'FITS' && verdict !== 'OFF')) {
    io.print('usage: feedback.mjs audit <commentId> --verdict FITS|OFF --reason "…" [--by label]');
    return 2;
  }
  const comment = readCommentRow(io.db, commentId);
  if (comment === undefined) {
    io.print(`unknown comment: ${commentId}`);
    return 1;
  }
  if (comment.audit_verdict !== null) {
    io.print(`refused: ${commentId} already has a verdict (first verdict wins)`);
    return 1;
  }
  if (comment.decided_at !== null) {
    io.print(`refused: ${commentId} is already decided — triage is not audited after the fact`);
    return 1;
  }

  const rawReason = parsed.flags.get('reason');
  const checked = rawReason === undefined ? null : validateReason(rawReason);
  if (checked !== null && !checked.ok) {
    io.print(`refused: ${checked.reason}`);
    return 1;
  }
  const reason = checked === null ? null : checked.reason;
  const label = (parsed.flags.get('by') ?? '').replace(/\s+/gu, ' ').trim();
  if (label.length > COMMENT_AUDITED_BY_MAX_CHARS) {
    io.print(`refused: --by is longer than ${COMMENT_AUDITED_BY_MAX_CHARS} characters`);
    return 1;
  }
  const by = label.length === 0 ? null : label;

  const at = now().toISOString();
  if (verdict === 'OFF') {
    if (reason === null) {
      io.print('refused: OFF needs --reason "…" — the reader sees that line as the refusal');
      return 1;
    }
    const recorded = recordAudit(io.db, { commentId: comment.id, verdict, reason, by, at });
    if (!recorded.ok) {
      io.print(`refused (${recorded.code}): ${recorded.message}`);
      return 1;
    }
    appendDecision(io.dir, {
      id: comment.id,
      status: 'rejected',
      reason,
      at,
      batch: comment.batch_id,
      changeId: null,
    });
    io.print(`${comment.id}: OFF · отклонено, читатель увидит причину`);
    return 0;
  }

  const recorded = recordAudit(io.db, { commentId: comment.id, verdict, reason, by, at });
  if (!recorded.ok) {
    io.print(`refused (${recorded.code}): ${recorded.message}`);
    return 1;
  }
  io.print(`${comment.id}: FITS · можно решать`);
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
  const reason = validateReason(parsed.flags.get('reason') ?? '');
  if (!reason.ok) {
    io.print(`refused: ${reason.reason}`);
    return 1;
  }
  if (comment.chapter === 67) {
    io.print('refused: глава 67 заморожена — правка читателя туда не входит (ENDING_FROZEN)');
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

  // One edit budget for both paths: a proposed edit already took its identity and network
  // slots at POST (§14, BOOK-DOC-4 rule 5). A plain comment spends both here, once, and only
  // after the change exists — a refusal leaves each budget intact.
  const limiter = new RateLimiter(io.db, () => now().getTime());
  const editLimit = io.editsPerDay ?? 1;
  const editBudgets: Array<{ spec: LimitSpec; budget: 'identity' | 'ip' }> = [];
  if (comment.proposed_text === null) {
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
  });
  if ('error' in accepted) {
    const prefix = accepted.code === undefined ? 'refused' : `refused (${accepted.code})`;
    io.print(`${prefix}: ${accepted.error}`);
    return 1;
  }
  // The slot is taken only once the change exists: a refusal must leave the budget intact.
  // Both keys are recorded in one transaction, so a fault cannot spend one and not the other.
  if (comment.proposed_text === null) {
    const atMs = now().getTime();
    io.db.transaction(() => {
      for (const { spec } of editBudgets) limiter.record(spec.key, atMs);
    })();
  }
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
  });
  io.print(`${comment.id}: accepted → ${accepted.changeId}`);
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

function appendDecision(dir: string, line: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'decisions.jsonl'), `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function parseRev(raw: string | undefined): { chapter: number; rev: number } | null {
  if (raw === undefined) return null;
  const match = /^ch(\d{1,2})@(\d{1,6})$/u.exec(raw.trim());
  if (match === null) return null;
  const chapter = Number.parseInt(match[1] ?? '', 10);
  const rev = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > 67) return null;
  if (!Number.isInteger(rev) || rev < 0) return null;
  return { chapter, rev };
}

function intFlag(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
