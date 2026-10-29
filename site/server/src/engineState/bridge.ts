/**
 * The site's bridge from the engine's tables to the reader's socket (ARCHITECTURE.md §6.1,
 * §10.3a, §10.4, §20 M4).
 *
 * The engine does not call the site. It writes facts (`change_events`, `events`, `meta`);
 * this bridge polls them at 500 ms, turns the difference into `change:*`, `cascade:progress`
 * and `engine:state` frames, and then hands the reader a `state:updated` snapshot so the
 * narrative and the state agree.
 *
 * Only the public projection is emitted: `changes`, `cascades`, `steps` — never
 * `gate_verdicts` (§6B.6). A cursor is primed on start, so a site restart does not replay
 * yesterday's queue as if it were happening now; a reconnect rebuilds from `state`.
 */

import {
  parseSeams,
  readerReason,
  type ChangeAdaptedPayload,
  type EngineStatePayload,
  type ServerEventType,
  type StateSnapshot,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { aheadOf, decidedPayload, queuedPayload, type ChangeEventRow } from './bridgePayloads.ts';
import { ChapterNarrator } from './chapterFrames.ts';
import { filingCloseFrame, filingFailureFrame } from './filingFrame.ts';
import { PassNarrator } from './passFrames.ts';

import { publicIntent, readCascadeRow, readChangeRow, readRelevance, readStepRow } from './changes.ts';
import { toHistoryFrame } from '../history/events.ts';
import { readEngineHealth, readLaneDay, readQueue, stepsOfCascade } from './reader.ts';
import { boundaryOf, chapterOfStep, safeJson, type CascadeRow, type ChangeRow, type StepRow } from './rows.ts';
import { wingsOf, wingSteps } from './wings.ts';

export type BridgeEmit = (type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown) => void;

export type EngineBridgeOptions = {
  db: Db;
  emit: BridgeEmit;
  /** The snapshot to publish after a frame; omitted in tests that only inspect events. */
  snapshot?: () => StateSnapshot;
  intervalMs?: number;
  now?: () => number;
  /** Replay facts already in the database (tests); a running site primes instead. */
  replay?: boolean;
  /** Per-cascade coalescing, 1 000 ms in production (§10.3a). */
  progressThrottleMs?: number;
  /**
   * The data dir the revision snapshots live under (BOOK-DOC-84 #6): `chapter:applied` derives
   * its patch and span from them. Absent (a test that only narrates rows) means no snapshot can
   * be read, and the frame is honestly `patchTruncated`.
   */
  dataDir?: string;
  /** The lane's day bound, announced by `engine:state` (§5); the writer's own default is 4. */
  maxPasses?: number;
};

type CommentEventRow = {
  id: number;
  comment_id: string;
  at: string;
  type: string;
  meta: string | null;
};

/** The filing events that owe the open page a frame (BOOK-206 B5): a read that never happened. */
const FILING_FAILURE_EVENTS = new Set(['triage.failed', 'triage.abandoned']);

type HistoryRow = {
  hseq: number;
  at: string;
  kind: string;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  chapter: number | null;
  is_front: number;
  payload: string;
};

const CASCADE_KINDS = new Set(['cascade.opened', 'cascade.closed', 'step.opened', 'step.closed']);

export class EngineBridge {
  private readonly db: Db;
  private readonly emit: BridgeEmit;
  private readonly snapshot: (() => StateSnapshot) | null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly replay: boolean;
  private readonly progressThrottleMs: number;
  private readonly maxPasses: number;
  private readonly chapters: ChapterNarrator;
  private readonly passes: PassNarrator;
  private readonly pendingProgress = new Map<string, { payload: unknown; at: number }>();
  private readonly lastProgressAt = new Map<string, number>();

  private changeCursor = 0;
  private eventCursor = 0;
  /** BOOK-206 B5 — the filing's own audit log; a read that failed is a fact the page must hear. */
  private commentCursor = 0;
  /** Every log entry is a chronicle tick, not only the cascade's (§11.10, §6F.1). */
  private historyCursor = 0;
  private status: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: EngineBridgeOptions) {
    this.db = options.db;
    this.emit = options.emit;
    this.snapshot = options.snapshot ?? null;
    this.intervalMs = options.intervalMs ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.replay = options.replay === true;
    this.progressThrottleMs = options.progressThrottleMs ?? 1_000;
    this.maxPasses = options.maxPasses ?? 4;
    const emit: BridgeEmit = (type, data) => this.emit(type, data);
    this.chapters = new ChapterNarrator({ db: this.db, dataDir: options.dataDir ?? '', emit });
    this.passes = new PassNarrator({ db: this.db, emit });
  }

  start(): void {
    if (this.timer !== null) return;
    this.prime();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // A malformed row must not stop the reader's narrative; the next tick retries.
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Mark everything already in the tables as "known": only new facts are narrated. */
  prime(): void {
    if (this.replay) {
      this.changeCursor = 0;
      this.eventCursor = 0;
      this.commentCursor = 0;
      this.historyCursor = 0;
      this.chapters.prime(true);
      this.passes.prime(true);
    } else {
      const change = this.db.prepare('SELECT MAX(id) AS id FROM change_events').get() as { id: number | null };
      const event = this.db.prepare('SELECT MAX(hseq) AS hseq FROM events').get() as { hseq: number | null };
      // BOOK-206 B5: a restart must not replay yesterday's cap failures as today's news.
      const comment = this.db.prepare('SELECT MAX(id) AS id FROM comment_events').get() as { id: number | null };
      this.chapters.prime(false);
      this.passes.prime(false);
      this.changeCursor = change.id ?? 0;
      this.eventCursor = event.hseq ?? 0;
      this.commentCursor = comment.id ?? 0;
      this.historyCursor = event.hseq ?? 0;
    }
    this.status = readEngineHealth(this.db, this.now()).status;
  }

  /** One poll. Public so a test can drive the bridge without waiting 500 ms. */
  tick(): { changes: number; cascades: number; engine: boolean; filing: number } {
    const nowMs = this.now();
    let changed = false;

    const engine = this.narrateEngine(nowMs);
    // The write first: a print is clocked from it, and the pass's own frames follow it.
    const revisions = this.chapters.tick();
    const passes = this.passes.tick();
    const cascades = this.drainCascade(nowMs) + this.flushProgress(nowMs);
    const changes = this.drainChanges(nowMs);
    const filing = this.drainFilingEvents(nowMs);
    const history = this.drainHistory();
    changed =
      engine || revisions > 0 || passes > 0 || cascades > 0 || changes > 0 || filing > 0 || history > 0;

    if (changed && this.snapshot !== null) {
      this.emit('state:updated', { ...this.snapshot(), reason: 'engine' });
    }
    return { changes, cascades, engine, filing };
  }

  // ── engine:state ──────────────────────────────────────────────────────────

  private narrateEngine(nowMs: number): boolean {
    const health = readEngineHealth(this.db, nowMs);
    if (health.status === this.status) return false;
    this.status = health.status;
    const lane = readLaneDay(this.db, nowMs, this.maxPasses);
    const payload: EngineStatePayload = {
      status: health.status,
      since: health.heartbeatAt,
      reason: engineReason(health.status),
      queue: { depth: readQueue(this.db, nowMs).depth },
      // BOOK-DOC-84 §5: the day's bound, announced as a fact — «на сегодня всё · 4 из 4».
      passesToday: lane.passesToday,
      maxPasses: lane.maxPasses,
      writerAt: lane.writerAt,
    };
    this.emit('engine:state', payload);
    return true;
  }

  // ── change:* from the change's own audit log ──────────────────────────────

  private drainChanges(nowMs: number): number {
    const rows = this.db
      .prepare('SELECT id, change_id, at, type, meta FROM change_events WHERE id > ? ORDER BY id')
      .all(this.changeCursor) as ChangeEventRow[];
    let emitted = 0;
    for (const row of rows) {
      this.changeCursor = row.id;
      const change = readChangeRow(this.db, row.change_id);
      if (change === undefined) continue;
      // BOOK-7: a premise is not in the lane — it must not announce a queue place, a
      // processing stage or a stale base it never had. Its decision is still a fact.
      if (change.premise === 1 && (row.type === 'queued' || row.type === 'processing' || row.type === 'stale')) {
        continue;
      }
      if (row.type === 'queued') {
        this.emit('change:queued', queuedPayload(this.db, change, row, nowMs));
        emitted += 1;
      } else if (row.type === 'processing') {
        this.emit('change:processing', {
          id: change.id,
          chapter: change.chapter,
          startedAt: change.started_at ?? row.at,
          attempt: change.attempts + 1,
          relevance: readRelevance(change.relevance),
          // BOOK-DOC-84 #10: the place in line at the claim, so the page does not refetch.
          queue: { ahead: aheadOf(this.db, change) },
          at: Date.parse(row.at),
          eventSeq: row.id,
        });
        emitted += 1;
      } else if (row.type === 'stale') {
        const relevance = readRelevance(change.relevance);
        const meta = safeJson<{ grade?: string }>(row.meta);
        this.emit('change:stale', {
          id: change.id,
          grade: relevance?.grade ?? meta?.grade ?? 'unknown',
          evidence: relevance?.evidence ?? [],
          options: ['adapt', 'drop'],
          survivesAs: relevance?.reason ?? null,
          at: Date.parse(row.at),
          eventSeq: row.id,
        });
        emitted += 1;
      } else if (row.type === 'adapted') {
        const meta = safeJson<{ intent?: string; reason?: string }>(row.meta);
        const payload: ChangeAdaptedPayload = {
          id: change.id,
          chapter: change.chapter,
          // The narrowed intent is the change's own public text (BOOK-DOC-84 #11).
          intent: publicIntent(meta?.intent ?? change.intent),
          reason: meta?.reason ?? readerReason(change.reason) ?? '',
          at: Date.parse(row.at),
          eventSeq: row.id,
        };
        this.emit('change:adapted', payload);
        emitted += 1;
      } else if (row.type === 'decided' || row.type === 'escalated' || row.type === 'cancelled') {
        this.emit('change:decided', decidedPayload(this.db, change, row, nowMs));
        emitted += 1;
        // BOOK-219/BOOK-206 B2 — the change's own word is not the filing's: the open page moves a
        // filing row only on `comment:decision`, so a close that decided the filing speaks here
        // too — a landing (`applied`) and a stop (`rejected`, escalated or failed) alike. One row,
        // one frame: the drain cursor has already passed this row, so a later tick cannot repeat
        // it. The change's own frames above are never replaced by it.
        const filing = filingCloseFrame(this.db, change, row.at, nowMs);
        if (filing !== null) {
          this.emit('comment:decision', filing);
          emitted += 1;
        }
      }
    }
    return emitted;
  }

  // ── comment:decision from the filing's own audit log ────────────────────

  /**
   * BOOK-206 B5 — a read that never happened is a filing transition, and `comment_events` is
   * where the engine writes it. The bridge drained `change_events` and `events` and not this
   * table, so a reader connected to the socket never saw the cap: the page kept «ждёт» while
   * `dueTriage` had already excluded the row.
   *
   * Only the two failure kinds owe a frame (`triage.failed`, `triage.abandoned`), and the
   * attempt's own `retryAt` rides along so the page can name the hour the next read is bought.
   * Every other row still moves the cursor — a restart primes it, so a replay of yesterday's
   * failures is never narrated as today's.
   */
  private drainFilingEvents(nowMs: number): number {
    const rows = this.db
      .prepare('SELECT id, comment_id, at, type, meta FROM comment_events WHERE id > ? ORDER BY id')
      .all(this.commentCursor) as CommentEventRow[];
    let emitted = 0;
    for (const row of rows) {
      this.commentCursor = row.id;
      if (!FILING_FAILURE_EVENTS.has(row.type)) continue;
      const frame = filingFailureFrame(
        this.db,
        row.comment_id,
        row.at,
        nowMs,
        safeJson<{ retryAt?: string }>(row.meta),
      );
      if (frame === null) continue;
      this.emit('comment:decision', frame);
      emitted += 1;
    }
    return emitted;
  }

  // ── history:event — a bare tick: the log moved, the client refetches ─────

  private drainHistory(): number {
    // BOOK-102: the frame's whole payload is `{ hseq, at }` — an event's kind, change number
    // and summary are the machine narrating, so nothing but the moment is selected here.
    const rows = this.db
      .prepare('SELECT hseq, at FROM events WHERE hseq > ? ORDER BY hseq LIMIT 200')
      .all(this.historyCursor) as Array<{ hseq: number; at: string }>;
    for (const row of rows) {
      this.historyCursor = row.hseq;
      this.emit('history:event', toHistoryFrame(row));
    }
    return rows.length;
  }

  // ── cascade:progress from the history log ─────────────────────────────────

  private drainCascade(nowMs: number): number {
    const rows = this.db
      .prepare(
        `SELECT hseq, at, kind, change_id, cascade_id, step_id, chapter, is_front, payload
           FROM events WHERE hseq > ? ORDER BY hseq`,
      )
      .all(this.eventCursor) as HistoryRow[];
    let emitted = 0;
    for (const row of rows) {
      this.eventCursor = row.hseq;
      if (!CASCADE_KINDS.has(row.kind) || row.cascade_id === null) continue;
      const cascade = readCascadeRow(this.db, row.cascade_id);
      if (cascade === undefined) continue;
      const change = readChangeRow(this.db, cascade.change_id);
      if (change === undefined) continue;
      const step = row.step_id === null ? undefined : readStepRow(this.db, row.step_id);
      const payload = this.progressPayload(cascade, change, step, row, nowMs);
      if (this.progressThrottleMs > 0) {
        this.pendingProgress.set(cascade.id, { payload, at: nowMs });
      } else {
        this.emit('cascade:progress', payload);
        this.lastProgressAt.set(cascade.id, nowMs);
        emitted += 1;
      }
    }
    return emitted;
  }

  private flushProgress(nowMs: number): number {
    if (this.progressThrottleMs <= 0) return 0;
    let emitted = 0;
    for (const [cascadeId, pending] of this.pendingProgress) {
      const last = this.lastProgressAt.get(cascadeId) ?? 0;
      if (nowMs - last < this.progressThrottleMs) continue;
      this.pendingProgress.delete(cascadeId);
      this.lastProgressAt.set(cascadeId, nowMs);
      this.emit('cascade:progress', pending.payload);
      emitted += 1;
    }
    return emitted;
  }

  private progressPayload(
    cascade: CascadeRow,
    change: ChangeRow,
    step: StepRow | undefined,
    row: HistoryRow,
    nowMs: number,
  ) {
    const steps = stepsOfCascade(this.db, cascade.id);
    const touched = new Set<number>([change.chapter]);
    const rewritten = new Set<number>();
    for (const entry of steps) {
      if (entry.chapter === null) continue;
      touched.add(entry.chapter);
      if (entry.outcome === 'rewritten' || entry.outcome === 'published_with_finding') rewritten.add(entry.chapter);
    }
    const budget = safeJson<{ maxSteps?: number; maxWallMs?: number }>(cascade.budget) ?? {};
    const maxWallMs = budget.maxWallMs ?? 1_800_000;
    const before = step?.rev_before ?? null;
    const after = step?.rev_after ?? null;

    return {
      cascadeId: cascade.id,
      changeId: cascade.change_id,
      origin: change.chapter,
      wave: step?.wave ?? cascade.wave,
      lane: step?.lane ?? null,
      chapter: step === undefined ? (change.chapter === 1 ? 'front' : change.chapter) : chapterOfStep(step),
      boundary:
        step === undefined
          ? boundaryOf(String(change.chapter), 'change', change.chapter)
          : boundaryOf(step.boundary, step.pass, step.chapter),
      phase: phaseOf(row.kind, step?.outcome ?? null),
      outcome: step?.outcome ?? null,
      rev: { before, after },
      frontier: {
        forward: forwardFrontier(steps, change.chapter),
        backward: backwardFrontier(steps, change.chapter),
      },
      wings: wingsOf(wingSteps(steps), change.chapter, cascade.status),
      touched: [...touched].sort((left, right) => left - right),
      rewritten: [...rewritten].sort((left, right) => left - right),
      seamsIn: step === undefined ? [] : parseSeams(safeJson(step.seams_in)),
      seamsOut: step === undefined ? [] : parseSeams(safeJson(step.seams_out)),
      budget: {
        steps: steps.length,
        maxSteps: budget.maxSteps ?? 8,
        msLeft: Math.max(0, Date.parse(cascade.opened_at) + maxWallMs - nowMs),
      },
    };
  }
}

function phaseOf(kind: string, outcome: StepRow['outcome']): 'rewrite' | 'holds' | 'absorbed' | 'escalated' {
  if (kind === 'cascade.closed') return 'absorbed';
  if (outcome === 'escalated') return 'escalated';
  if (outcome === 'holds' || outcome === 'evaluated') return 'holds';
  return 'rewrite';
}

function forwardFrontier(steps: StepRow[], origin: number): number {
  const forward = steps.filter((step) => step.pass === 'cascade' && step.lane === 'forward' && step.chapter !== null);
  return forward.length === 0 ? origin : Math.max(...forward.map((step) => step.chapter as number));
}

function backwardFrontier(steps: StepRow[], origin: number): number {
  const backward = steps.filter((step) => step.pass === 'cascade' && step.lane === 'backward' && step.chapter !== null);
  return backward.length === 0 ? origin : Math.min(...backward.map((step) => step.chapter as number));
}

function engineReason(status: string): string {
  if (status === 'paused') return 'правки приостановлены';
  if (status === 'throttled') return 'дневной лимит правок';
  if (status === 'down') return 'движок не отвечает';
  if (status === 'absent') return 'движок не запущен';
  return 'движок работает';
}
