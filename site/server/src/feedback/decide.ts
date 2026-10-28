/**
 * `feedback.mjs decide` — the one writer of a decision about a filing (ARCHITECTURE.md §12.6).
 *
 * It lives beside `cli.ts` rather than inside it because the argv shape and the decision are two
 * different jobs: the CLI parses flags and prints sentences, this module asks the gates, records
 * the answer and hands the reader a line. It never calls a model and never writes prose.
 *
 * BOOK-174 adds the one second decision the ladder allows: an escalated filing waits for the
 * author, so `decide <id> accepted` places it and `decide <id> rejected` ends it. No other row
 * may be decided twice — first decision wins, as it always did.
 */

import {
  EDIT_DAY_MS,
  holdsInternalCode,
  TOTAL_CHAPTERS,
  normalizeRetroMode,
  validateInterventionKind,
  validateIntent,
  validateReason,
} from '@book/shared';

import { readCommentRow } from '../comments/repo.ts';
import { isEditExempt } from '../comments/budget.ts';
import { editIdentityKey, editIpKeyFromHash } from '../rate/policy.ts';
import { RateLimiter, type LimitSpec } from '../rate/limiter.ts';
import { acceptComment } from './accept.ts';
import { refuseEscalated } from './author.ts';
import { appendDecision } from './decisionsFile.ts';
import { disposeRejection } from './dispositionStore.ts';
import { chapterVocabulary } from './vocabulary.ts';
import { settleAttempt, spendFromFlags } from './triage.ts';
import type { FeedbackIo, ParsedArgs } from './cli.ts';

export function decide(parsed: ParsedArgs, io: FeedbackIo, now: () => Date): number {
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
  // BOOK-174: an escalated filing is **waiting for the author**, so this is the one row a second
  // decision may move — and only one: once it is accepted or refused, the first decision wins
  // again. The answer must be named as the author's (`--as author`): a re-run of the triage line
  // that escalated the filing is a retry, not an answer, and it must not turn an escalation into
  // a refusal (or spend the attempt twice).
  const escalated = comment.status === 'escalated';
  const asAuthor = parsed.flags.get('as') === 'author';
  if (comment.decided_at !== null && !escalated) {
    io.print(`refused: ${commentId} is already decided (first decision wins)`);
    return 1;
  }
  if (escalated && !asAuthor) {
    io.print(
      `refused: ${commentId} waits for the author — answer with decide <id> accepted|rejected --as author`,
    );
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
  if (verdict === 'rejected' && escalated) {
    // The author answers the question the ladder asked. «No» is the end of the ladder, and the
    // one refusal that needs no lock: the book's owner speaking, not a gate.
    refuseEscalated(io.db, { comment, at, reason: reason.reason });
    appendDecision(io.dir, {
      id: comment.id,
      status: 'rejected',
      reason: reason.reason,
      at,
      batch: comment.batch_id,
      changeId: null,
    });
    // The attempt is closed as `refused`: the author read it and said no — nobody else refused it.
    settleAttempt(io.db, { commentId: comment.id, chapter: comment.chapter, outcome: 'refused', at, spend: spend.spend });
    io.print(`${comment.id}: rejected — решает автор: отклонено`);
    return 0;
  }
  if (verdict === 'rejected') {
    // BOOK-174: a rejection is a refusal only under a lock; otherwise the filing is escalated
    // and the author decides. The exchange file keeps its two words (`rejected`), the row keeps
    // its own: the site's tailer emits the row's status, never the line's.
    const result = disposeRejection(io.db, { comment, at, batch: comment.batch_id, note: reason.reason });
    appendDecision(io.dir, {
      id: comment.id,
      status: 'rejected',
      reason: result.reason,
      at,
      batch: comment.batch_id,
      changeId: null,
    });
    // BOOK-158: the answer closes the attempt it replied to and still charges the call — the model
    // was paid either way. BOOK-174: only a lock is a refusal; an escalation is a filing waiting
    // for a person, and the ledger says `held` rather than pretending somebody refused it.
    settleAttempt(io.db, {
      commentId: comment.id,
      chapter: comment.chapter,
      outcome: result.status === 'rejected' ? 'refused' : 'held',
      at,
      spend: spend.spend,
    });
    io.print(`${comment.id}: ${result.status}${result.decision.lock === null ? '' : ` (${result.decision.lock})`}`);
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
  // BOOK-174: the ladder could not place the filing and no lock applies. Nothing was queued, no
  // slot is spent, and the row waits for the author — one `escalated` record and one file line.
  if ('escalated' in accepted) {
    const escalation = disposeRejection(io.db, {
      comment,
      at,
      batch: comment.batch_id,
      note: accepted.decision.reason,
    });
    appendDecision(io.dir, {
      id: comment.id,
      status: 'rejected',
      reason: escalation.reason,
      at,
      batch: comment.batch_id,
      changeId: null,
    });
    settleAttempt(io.db, { commentId: comment.id, chapter: comment.chapter, outcome: 'held', at, spend: spend.spend });
    io.print(`${comment.id}: escalated — решает автор`);
    return 0;
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