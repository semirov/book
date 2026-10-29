/**
 * Decisions tailing (ARCHITECTURE.md §12.6, §10).
 *
 * `feedback.mjs decide` appends one line to `decisions.jsonl`; the site tails the file and
 * turns each line into a fact: the comment's status, a queued change (acceptance), and the
 * reader-visible events `comment:decision` / `change:queued`. Files are the source of truth,
 * so the whole path works with the site stopped and reconciles on boot.
 *
 * Idempotent by construction: first decision wins, a re-read line changes nothing, and an
 * accepted line whose change already exists is only re-announced once.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  holdsInternalCode,
  normalizeRetroMode,
  readerReason,
  validateIntent,
  validateInterventionKind,
  type CommentDecisionPayload,
  type DispositionReport,
  type RetroMode,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { appendCommentEvent, readCommentRow, type CommentRow } from '../comments/repo.ts';
import { countRows, safeJson } from '../engineState/rows.ts';
import { readQueue } from '../engineState/reader.ts';
import { readAuthor, publicIntent } from '../engineState/changes.ts';
import type { ChangeRow } from '../engineState/rows.ts';
import { acceptComment } from './accept.ts';
import { parseDispositionProposal, type DispositionProposal } from './disposition.ts';
import { reportOfDecision, disposeRejection, storedDecision } from './dispositionStore.ts';
import { chapterVocabulary } from './vocabulary.ts';

export type DecisionEmit = (type: 'comment:decision' | 'change:queued' | 'feedback:batch', data: unknown) => void;

export type DecisionLine = {
  id: string;
  status: 'accepted' | 'rejected';
  reason: string;
  intent?: string | null;
  at: string;
  batch?: string | null;
  changeId?: string | null;
  rev?: { chapter: number; rev: number } | null;
  base?: { sha256: string } | null;
  /**
   * BOOK-137 — the paperwork mode the triage named for a filing that touches the frozen frame;
   * an unknown word is dropped here, exactly as `normalizeRetroMode` drops it anywhere else.
   */
  mode?: RetroMode | null;
  /**
   * BOOK-174 — the triage line's own reading of the filing (how it asks to be read). Absent is
   * `as_said`: the gates already passed. The chooser is the arbiter of what is allowed; the line
   * only proposes.
   */
  disposition?: DispositionProposal | null;
};

export type DecisionsTailerOptions = {
  db: Db;
  dir: string;
  emit: DecisionEmit;
  now?: () => Date;
  /** Apply the whole file on start (tests); a running site primes to the end instead. */
  replay?: boolean;
  /**
   * BOOK-189 — called once for a filing **refused at triage**. A rejection never becomes a
   * change, so the engine's decision hook can never speak for it: without this the reader would
   * wait for an answer that the queue has already given. Accepted lines are not announced here;
   * their change is, when it is decided.
   */
  /**
   * BOOK-189/BOOK-174 — the reader's push, once per filing. The report travels with it: it is the
   * answer the notification speaks, and a filing with no reading (a gate's hold) passes `null`.
   */
  notify?: (commentId: string, report: DispositionReport | null) => void;
};

const OFFSET_KEY = 'feedback_decisions_offset';
const BATCH_KEY = 'feedback_batch_cursor';

export class DecisionsTailer {
  private readonly db: Db;
  private readonly file: string;
  private readonly emit: DecisionEmit;
  private readonly now: () => Date;
  private readonly replay: boolean;
  private readonly notify: ((commentId: string, report: DispositionReport | null) => void) | null;
  private offset = 0;
  private batchCursor: string | null = null;

  constructor(options: DecisionsTailerOptions) {
    this.db = options.db;
    this.file = join(options.dir, 'decisions.jsonl');
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date());
    this.replay = options.replay === true;
    this.notify = options.notify ?? null;
  }

  /** Read the cursor once: a restart must not replay yesterday's decisions as news. */
  prime(): void {
    if (this.replay) {
      this.offset = 0;
      this.batchCursor = null;
      return;
    }
    const stored = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(OFFSET_KEY) as { v: string } | undefined;
    this.offset = stored === undefined ? this.fileSize() : Number.parseInt(stored.v, 10);
    if (!Number.isFinite(this.offset) || this.offset < 0 || this.offset > this.fileSize()) this.offset = 0;
    const cursor = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(BATCH_KEY) as { v: string } | undefined;
    this.batchCursor = cursor?.v ?? null;
    if (this.batchCursor === null) this.batchCursor = this.currentBatchCursor();
  }

  /** One tick: apply new decision lines, then announce new batches. Returns the events emitted. */
  poll(): number {
    let emitted = 0;
    for (const line of this.readNewLines()) {
      emitted += this.apply(line);
    }
    emitted += this.announceBatches();
    return emitted;
  }

  /** Applies one decision; public so a test can call it without a file. */
  apply(line: unknown): number {
    const decision = parseDecision(line);
    if (decision === null) return 0;
    const comment = readCommentRow(this.db, decision.id);
    if (comment === undefined) return 0;

    const at = typeof decision.at === 'string' ? decision.at : this.now().toISOString();
    // BOOK-206: first decision wins, always — there is no second decision and no author's door.
    if (comment.decided_at !== null) {
      // First decision wins. A replay of the same decision is announced once more (the CLI
      // writes the DB state before the tailer reads the line, so this is the normal path);
      // a different decision is recorded and ignored.
      const sameChange =
        decision.status === 'accepted'
          ? decision.changeId !== null && comment.change_id === decision.changeId
          : comment.status === 'rejected';
      if (!sameChange) {
        appendCommentEvent(this.db, comment.id, 'decision-ignored', at, { reason: 'first decision wins' });
        return 0;
      }
      this.emit('comment:decision', {
        id: comment.id,
        chapter: comment.chapter,
        status: decision.status,
        reason: comment.reason ?? decision.reason,
        decidedAt: comment.decided_at,
        batchId: comment.batch_id,
        changeId: comment.change_id,
        queue: { depth: readQueue(this.db, this.now().getTime()).depth, ahead: 0 },
        source: 'llm',
        report: this.reportOf(comment),
      } satisfies CommentDecisionPayload);
      if (comment.change_id !== null) this.announceQueued(comment.change_id);
      // BOOK-189: this is the **normal** path for a refusal, not an edge — `feedback.mjs decide`
      // writes the row before it appends the line, so the re-announce branch above is where a
      // refused filing's author is heard. The push claim (`push_log`) makes a re-read of the same
      // line a duplicate instead of a second notification.
      if (decision.status === 'rejected') this.notify?.(comment.id, this.reportOf(comment));
      return 1;
    }

    if (decision.status === 'rejected') {
      // BOOK-206: a refusal with no lock writes nothing, and the tick counts nothing for it.
      return this.reject(comment, decision.reason, at, decision.batch ?? null) ? 1 : 0;
    }

    // BOOK-16: the kind stored with the comment reaches the intent validation and then the
    // change (through `acceptComment`), so the site's path and the CLI judge one thing.
    //
    // A stored kind this build does not know is **refused**, exactly as `feedback.mjs decide`
    // refuses it: the line is not applied and the comment stays undecided (it keeps its batch
    // status, so triage sees it again), with an internal `decision-refused` event naming the
    // code. Normalising it to null would accept a newer kind as "no kind" — silent, and the
    // writer would be told nothing about the world-fact.
    const storedKind =
      comment.intervention_kind === null ? null : validateInterventionKind(comment.intervention_kind);
    if (storedKind !== null && !storedKind.ok) {
      appendCommentEvent(this.db, comment.id, 'decision-refused', at, { code: storedKind.code });
      return 0;
    }
    const verdict = validateIntent(decision.intent ?? '', comment.chapter, {
      vocabulary: chapterVocabulary(this.db, comment.chapter),
      kind: storedKind === null ? null : storedKind.kind,
    });
    if (!verdict.ok) {
      return this.reject(comment, verdict.reason, at, decision.batch ?? null) ? 1 : 0;
    }

    const accepted = acceptComment(this.db, {
      comment,
      intent: verdict.intent,
      at,
      reason: decision.reason,
      changeId: decision.changeId ?? null,
      baseRev: decision.rev?.rev ?? null,
      batch: decision.batch ?? null,
      frameMode: decision.mode ?? null,
      proposal: decision.disposition ?? null,
    });
    if ('error' in accepted) {
      // BOOK-61/BOOK-174: a gate that has not spoken is not a decision — A's hold, B's rights
      // and C's auditor keep exactly the answer they always gave, untouched by the ladder.
      if (
        accepted.code === 'AUDIT_REQUIRED' ||
        accepted.code === 'RIGHTS_REQUIRED' ||
        accepted.code === 'QUARANTINED'
      ) {
        this.refuseAtGate(comment, accepted.error, at, decision.batch ?? null);
        return 1;
      }
      return this.reject(comment, accepted.error, at, decision.batch ?? null) ? 1 : 0;
    }

    const queue = readQueue(this.db, this.now().getTime());
    const change = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(accepted.changeId) as
      | ChangeRow
      | undefined;
    // BOOK-7: a premise is not a queued change — the reader's own line says «принято в
    // основу», and a second premise carries its public refusal instead of a place in line.
    const superseded = change?.premise === 1 && change.status === 'void';
    const ahead =
      change === undefined || change.premise === 1
        ? 0
        : countRows(this.db, `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0 AND seq < ?`, change.seq);
    const payload: CommentDecisionPayload = {
      id: comment.id,
      chapter: comment.chapter,
      status: 'accepted',
      reason: superseded ? (change?.reason ?? decision.reason) : decision.reason,
      decidedAt: at,
      batchId: decision.batch ?? null,
      changeId: accepted.changeId,
      queue: { depth: queue.depth, ahead },
      source: 'llm',
      // BOOK-174: the reading travels with the frame, so the open filing shows it at once.
      report: this.reportOf(readCommentRow(this.db, comment.id) ?? comment),
    };
    this.emit('comment:decision', payload);
    this.announceQueued(accepted.changeId);
    return 1;
  }

  /** The `change:queued` frame for a change that already exists (new or applied by the CLI). */
  private announceQueued(changeId: string): void {
    const change = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(changeId) as ChangeRow | undefined;
    if (change === undefined || change.premise === 1) return;
    // BOOK-137: paperwork never enters the lane, so «в очереди» is not a thing it can be.
    if (change.outcome === 'registered') return;
    const depth = readQueue(this.db, this.now().getTime()).depth;
    const ahead = countRows(
      this.db,
      `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND premise = 0 AND seq < ?`,
      change.seq,
    );
    this.emit('change:queued', {
      id: change.id,
      seq: change.seq,
      kind: change.kind,
      chapter: change.chapter,
      intent: publicIntent(change.intent),
      source: { commentId: change.source_comment, author: readAuthor(this.db, change.source_comment) },
      queue: { depth, ahead },
      base: { rev: change.base_rev },
      scopeHint: change.scope_hint,
    });
  }

  /**
   * BOOK-174 — a content rejection is not a refusal any more unless a lock applies. The one
   * helper decides: a lock → `rejected` with its chain and the lock's own line; no lock → nothing
   * at all (`false`), because the ladder places every filing and a person's line cannot refuse
   * one. A gate that has not spoken (`AUDIT_REQUIRED`, `RIGHTS_REQUIRED`, `QUARANTINED`) never
   * reaches here.
   */
  private reject(comment: CommentRow, reason: string, at: string, batch: string | null): boolean {
    // The engine's note stays in the event, where an operator can look it up; the reader is
    // owed the book's own word (`refuseAtGate` below keeps the old sentence for a gate that has
    // spoken and not decided anything about how the filing should be read).
    const result = disposeRejection(this.db, { comment, at, batch, note: publicDecisionReason(reason) });
    // BOOK-206: no lock, no refusal. The line is a diagnostic that asked for a state the ladder
    // cannot produce; the row keeps its own answer and nothing is emitted for it.
    if (result.status === 'no-lock') {
      appendCommentEvent(this.db, comment.id, 'decision-ignored', at, { reason: 'a refusal needs a lock' });
      return false;
    }
    this.emit('comment:decision', {
      id: comment.id,
      chapter: comment.chapter,
      status: result.status,
      reason: result.reason,
      decidedAt: at,
      batchId: batch,
      changeId: null,
      queue: { depth: readQueue(this.db, this.now().getTime()).depth, ahead: 0 },
      source: 'llm',
      report: reportOfDecision(this.db, result.decision, comment),
    } satisfies CommentDecisionPayload);
    // BOOK-189: the row is decided and the socket has spoken; the push goes out once, after both.
    // A filing with no change never gets a close to announce it, so this is its only answer — and
    // BOOK-174 makes the answer the reading, not a word about a refusal.
    this.notify?.(comment.id, reportOfDecision(this.db, result.decision, comment));
    return true;
  }

  /** The report of a row that already carries a chain; null for a row read before v27. */
  private reportOf(row: CommentRow): DispositionReport | null {
    const stored = storedDecision(row);
    return stored === null ? null : reportOfDecision(this.db, stored, row);
  }

  /** A gate's own refusal: unchanged by BOOK-174, and it stores no disposition chain. */
  private refuseAtGate(comment: CommentRow, reason: string, at: string, batch: string | null): void {
    const publicReason = publicDecisionReason(reason);
    this.db
      .prepare(
        `UPDATE comments SET status = 'rejected', decided_at = ?, reason = ?, batch_id = COALESCE(?, batch_id)
          WHERE id = ?`,
      )
      .run(at, publicReason, batch, comment.id);
    appendCommentEvent(this.db, comment.id, 'decided', at, { status: 'rejected' });
    this.emit('comment:decision', {
      id: comment.id,
      chapter: comment.chapter,
      status: 'rejected',
      reason: publicReason,
      decidedAt: at,
      batchId: batch,
      changeId: null,
      queue: { depth: readQueue(this.db, this.now().getTime()).depth, ahead: 0 },
      source: 'llm',
    } satisfies CommentDecisionPayload);
    // BOOK-189: the row is decided and the reader has been told on the socket; the push goes out
    // once, after both. A refused filing has no change to be decided later, so this is the only
    // moment its author can hear the answer. A gate's refusal stores no chain: the push speaks
    // the old sentence for it and nothing pretends a reading happened.
    this.notify?.(comment.id, null);
  }

  private announceBatches(): number {
    const cursor = this.batchCursor;
    const rows = this.db
      .prepare('SELECT id, created_at, count, chapter FROM feedback_batches ORDER BY created_at, id')
      .all() as Array<{ id: string; created_at: string; count: number; chapter: number | null }>;
    let emitted = 0;
    for (const row of rows) {
      const marker = `${row.created_at}|${row.id}`;
      if (cursor !== null && marker <= cursor) continue;
      this.emit('feedback:batch', {
        batchId: row.id,
        count: row.count,
        chapter: row.chapter,
        createdAt: row.created_at,
      });
      this.batchCursor = marker;
      emitted += 1;
    }
    if (this.batchCursor !== null) {
      this.db
        .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        .run(BATCH_KEY, this.batchCursor);
    }
    return emitted;
  }

  private readNewLines(): unknown[] {
    const size = this.fileSize();
    if (size <= this.offset) {
      if (size < this.offset) this.offset = 0;
      return [];
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(this.file);
    } catch {
      return [];
    }
    const chunk = buffer.subarray(this.offset);
    const text = chunk.toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak < 0) return [];
    const complete = text.slice(0, lastBreak);
    this.offset += Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8');
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(OFFSET_KEY, String(this.offset));

    return complete
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => safeJson<unknown>(line))
      .filter((value) => value !== null);
  }

  private fileSize(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  private currentBatchCursor(): string | null {
    const row = this.db
      .prepare('SELECT id, created_at FROM feedback_batches ORDER BY created_at DESC, id DESC LIMIT 1')
      .get() as { id: string; created_at: string } | undefined;
    return row === undefined ? null : `${row.created_at}|${row.id}`;
  }
}

/** The sentence a reader is owed when a decision line carries a handle instead of words. */
export const DECISION_FALLBACK = 'вне рамок: замечание не про текст этой главы';

/**
 * BOOK-158: the refusal the reader reads is a sentence, never an engine's handle. A line whose
 * reason is `PROVIDER_SHAPE`/`INTENT_SHAPE`, or nothing readable at all, is refused with the
 * book's own line — the code stays in the log, where an operator can look it up.
 */
export function publicDecisionReason(reason: string): string {
  if (holdsInternalCode(reason)) return DECISION_FALLBACK;
  return readerReason(reason)?.slice(0, 200) ?? DECISION_FALLBACK;
}

/** A line is a decision only when it names a comment, a status and a reason. */
export function parseDecision(raw: unknown): DecisionLine | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Partial<DecisionLine>;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (value.status !== 'accepted' && value.status !== 'rejected') return null;
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) return null;
  return {
    id: value.id,
    status: value.status,
    reason: value.reason,
    intent: typeof value.intent === 'string' ? value.intent : null,
    at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
    batch: typeof value.batch === 'string' ? value.batch : null,
    changeId: typeof value.changeId === 'string' ? value.changeId : null,
    rev: value.rev ?? null,
    base: value.base ?? null,
    mode: normalizeRetroMode(value.mode),
    disposition: parseDispositionProposal(value.disposition),
  };
}
