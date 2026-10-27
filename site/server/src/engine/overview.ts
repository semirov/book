/**
 * The engine's small reads (ARCHITECTURE.md §6D, §6A.12): the state line an operator and the
 * health check print, the trace of one record, the kind a comment declared, and the beat.
 *
 * None of them decides anything: they read rows the engine already wrote. They live apart
 * from `service.ts` so that module stays the protocol — land, gates, close — and not a
 * catalogue of every read.
 */

import { toIso } from '../util/time.ts';
import { dailyTokens } from './draft.ts';
import { beatOpenSteps } from './leases.ts';
import { readTrace, type TraceResult } from './trace.ts';
import { safeJson } from './helpers.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';

export type EngineState = {
  status: 'running' | 'throttled';
  lane: { holder: string | null; heartbeatAt: string | null };
  queue: { pending: number; processing: number; openCascades: number };
  steps: { open: number; leased: number };
  tokens: { today: number; dailyBudget: number };
  alerts: unknown;
  /** ADR-038 (BOOK-62): the model this engine's pipeline runs on; `/api/state` is untouched. */
  pipeline: { provider: string; model: string };
};

export function createOverview(deps: EngineDeps) {
  const { db, config } = deps;
  const iso = (ms: number = deps.clock.now()): string => toIso(ms);

  function state(): EngineState {
    const lane = store.readLane(db);
    const today = dailyTokens(db, deps.clock.now());
    return {
      status: today >= config.budgetDailyTokens ? 'throttled' : 'running',
      lane: { holder: lane.holder, heartbeatAt: lane.heartbeat_at },
      queue: {
        pending: store.countPending(db),
        processing: store.countProcessing(db),
        openCascades: store.listOpenCascades(db).length,
      },
      steps: { open: store.countOpenSteps(db), leased: store.liveLeases(db).length },
      tokens: { today, dailyBudget: config.budgetDailyTokens },
      alerts: safeJson(store.getMeta(db, 'engine.alerts')),
      pipeline: { provider: config.pipeline.provider, model: config.pipeline.model },
    };
  }

  function trace(identifier: string): TraceResult | null {
    return readTrace(deps, identifier);
  }

  /**
   * BOOK-16 — the kind stored with a comment, raw. The control route validates an intent
   * against the world-fact the change will carry (`queue.ts` copies the same column), and an
   * unknown value has to stay detectable, so it is returned as stored rather than normalized.
   */
  function commentKind(commentId: string): string | null {
    const row = db.prepare('SELECT intervention_kind FROM comments WHERE id = ?').get(commentId) as
      | { intervention_kind: string | null }
      | undefined;
    return row?.intervention_kind ?? null;
  }

  function heartbeat(): void {
    const at = deps.clock.now();
    store.setMeta(db, 'engine.heartbeat', iso(at));
    store.setMeta(db, 'engine.status', state().status);
    const lane = store.readLane(db);
    if (lane.holder) store.heartbeatLaneRow(db, lane.holder, iso(at));
    // BOOK-34: the engine beats the leases of its open steps itself (bounded by the step wall).
    beatOpenSteps(deps, at);
  }

  return { state, trace, commentKind, heartbeat };
}

export type Overview = ReturnType<typeof createOverview>;
