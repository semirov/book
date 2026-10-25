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

import { parseSeams, seamReason, type ServerEventType, type StateSnapshot } from '@book/shared';

import type { Db } from '../db/db.ts';
import {
  chaptersOfChange,
  decisionOutcome,
  publicIntent,
  readAuthor,
  readCascadeRow,
  readChange,
  readChangeRow,
  readRelevance,
  readStepRow,
} from './changes.ts';
import { toHistoryFrame, type EventRow } from '../history/events.ts';
import { readEngineHealth, readQueue, stepsOfCascade } from './reader.ts';
import { boundaryOf, chapterOfStep, countRows, safeJson, type CascadeRow, type ChangeRow, type StepRow } from './rows.ts';

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
};

type ChangeEventRow = {
  id: number;
  change_id: string;
  at: string;
  type: string;
  meta: string | null;
};

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
  private readonly pendingProgress = new Map<string, { payload: unknown; at: number }>();
  private readonly lastProgressAt = new Map<string, number>();

  private changeCursor = 0;
  private eventCursor = 0;
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
      this.historyCursor = 0;
    } else {
      const change = this.db.prepare('SELECT MAX(id) AS id FROM change_events').get() as { id: number | null };
      const event = this.db.prepare('SELECT MAX(hseq) AS hseq FROM events').get() as { hseq: number | null };
      this.changeCursor = change.id ?? 0;
      this.eventCursor = event.hseq ?? 0;
      this.historyCursor = event.hseq ?? 0;
    }
    this.status = readEngineHealth(this.db, this.now()).status;
  }

  /** One poll. Public so a test can drive the bridge without waiting 500 ms. */
  tick(): { changes: number; cascades: number; engine: boolean } {
    const nowMs = this.now();
    let changed = false;

    const engine = this.narrateEngine(nowMs);
    const cascades = this.drainCascade(nowMs) + this.flushProgress(nowMs);
    const changes = this.drainChanges(nowMs);
    const history = this.drainHistory();
    changed = engine || cascades > 0 || changes > 0 || history > 0;

    if (changed && this.snapshot !== null) {
      this.emit('state:updated', { ...this.snapshot(), reason: 'engine' });
    }
    return { changes, cascades, engine };
  }

  // ── engine:state ──────────────────────────────────────────────────────────

  private narrateEngine(nowMs: number): boolean {
    const health = readEngineHealth(this.db, nowMs);
    if (health.status === this.status) return false;
    this.status = health.status;
    this.emit('engine:state', {
      status: health.status,
      since: health.heartbeatAt,
      reason: engineReason(health.status),
      queue: { depth: readQueue(this.db, nowMs).depth },
    });
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
      if (row.type === 'queued') {
        this.emit('change:queued', this.queuedPayload(change, nowMs));
        emitted += 1;
      } else if (row.type === 'processing') {
        this.emit('change:processing', {
          id: change.id,
          chapter: change.chapter,
          startedAt: change.started_at ?? row.at,
          attempt: change.attempts + 1,
          relevance: readRelevance(change.relevance),
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
        });
        emitted += 1;
      } else if (row.type === 'decided' || row.type === 'escalated' || row.type === 'cancelled') {
        this.emit('change:decided', this.decidedPayload(change, row.at, nowMs));
        emitted += 1;
      }
    }
    return emitted;
  }

  private queuedPayload(change: ChangeRow, nowMs: number) {
    const ahead = countRows(
      this.db,
      `SELECT COUNT(*) AS n FROM changes WHERE status = 'pending' AND seq < ?`,
      change.seq,
    );
    return {
      id: change.id,
      seq: change.seq,
      kind: change.kind,
      chapter: change.chapter,
      intent: publicIntent(change.intent),
      source: { commentId: change.source_comment, author: readAuthor(this.db, change.source_comment) },
      queue: { depth: readQueue(this.db, nowMs).depth, ahead },
      base: { rev: change.base_rev },
      scopeHint: change.scope_hint,
    };
  }

  private decidedPayload(change: ChangeRow, at: string, nowMs: number) {
    const dto = readChange(this.db, change.id, nowMs);
    const cascade = dto?.cascade ?? null;
    return {
      id: change.id,
      commentId: change.source_comment,
      outcome: decisionOutcome(change),
      reason: change.reason === null ? null : seamReason(change.reason),
      chapters: chaptersOfChange(this.db, change),
      cascade:
        cascade === null
          ? null
          : {
              id: cascade.id,
              outcome: cascade.outcome,
              waves: cascade.wave,
              touched: [...new Set([...cascade.chaptersRewritten, ...cascade.chaptersChecked])].sort(
                (left, right) => left - right,
              ),
              rewritten: cascade.chaptersRewritten,
              seams: cascade.seams.map((seam) => ({ boundary: seam.boundary, resolved: seam.resolved })),
              finding: cascade.gates.findingSurvived,
            },
      relevance: dto?.relevance === null || dto?.relevance === undefined ? null : { grade: dto.relevance.grade },
      tokens: { total: change.tokens_in + change.tokens_out },
      decidedAt: change.finished_at ?? at,
    };
  }

  // ── history:event — every fact, as the chronicle's ticker (§11.10) ────────

  private drainHistory(): number {
    const rows = this.db
      .prepare(
        `SELECT e.*, (SELECT c.seq FROM changes c WHERE c.id = e.change_id) AS change_seq
           FROM events e WHERE e.hseq > ? ORDER BY e.hseq LIMIT 200`,
      )
      .all(this.historyCursor) as EventRow[];
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
