/**
 * Admin alerts (ARCHITECTURE.md §6B.4 rule 3, §6B.7).
 *
 * An alert is a durable record — `meta` keeps the last one and a counter, the change card
 * keeps the reason — not a log line that scrolls away. Only a finding that survived the
 * cycle cap and a stop by a bound raise one; a clean ripple raises nothing.
 *
 * `recordAlert` is the engine's door (it also notifies the injected sink); `recordAlertRow` is the
 * same record without an `EngineDeps` — the writer's `--audit-samples` runs beside the engine, not
 * inside it (BOOK-DOC-80), and it must not grow a second copy of the meta key or the counter.
 */

import type { CascadeOutcome } from '@book/shared';

import type { Db } from '../db/db.ts';
import { getMeta, setMeta } from './rows.ts';
import type { EngineAlert, EngineDeps } from './types.ts';

const ALERT_KIND: Record<string, EngineAlert['kind']> = {
  budget: 'budget',
  oscillation: 'oscillation',
  origin: 'origin',
  delta: 'delta',
  ending: 'ending',
  finding: 'finding',
  // BOOK-76: the physics pass stopping a change is its own alert, not a prose finding.
  science: 'science',
  // BOOK-61: a prose refusal by Gate B is its own alert, not a prose finding either.
  rights: 'rights',
  gate_timeout: 'gate_timeout',
  // BOOK-DOC-80: the editor disagreed with the local judge on a sampled change, or the judge is
  // drifting (two gaps in twenty): both are facts about the lane, not about one chapter.
  local_only: 'local_only',
};

export function alertKind(outcome: CascadeOutcome): EngineAlert['kind'] {
  const suffix = outcome.startsWith('escalated:') ? outcome.slice('escalated:'.length) : 'origin';
  return ALERT_KIND[suffix] ?? 'origin';
}

/** The record itself: one meta row, one counter, no second writer of either. */
export function recordAlertRow(db: Db, alert: EngineAlert, notify?: (alert: EngineAlert) => void): void {
  const previous = getMeta(db, 'engine.alerts');
  let count = 0;
  try {
    count = Number((JSON.parse(previous ?? '{}') as { count?: number }).count ?? 0);
  } catch {
    count = 0;
  }
  setMeta(db, 'engine.alerts', JSON.stringify({ count: count + 1, last: alert }));
  notify?.(alert);
}

export function recordAlert(deps: EngineDeps, alert: EngineAlert): void {
  recordAlertRow(deps.db, alert, deps.alert);
}
