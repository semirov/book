/**
 * Admin alerts (ARCHITECTURE.md §6B.4 rule 3, §6B.7).
 *
 * An alert is a durable record — `meta` keeps the last one and a counter, the change card
 * keeps the reason — not a log line that scrolls away. Only a finding that survived the
 * cycle cap and a stop by a bound raise one; a clean ripple raises nothing.
 */

import type { CascadeOutcome } from '@book/shared';

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
  gate_timeout: 'gate_timeout',
};

export function alertKind(outcome: CascadeOutcome): EngineAlert['kind'] {
  const suffix = outcome.startsWith('escalated:') ? outcome.slice('escalated:'.length) : 'origin';
  return ALERT_KIND[suffix] ?? 'origin';
}

export function recordAlert(deps: EngineDeps, alert: EngineAlert): void {
  const previous = getMeta(deps.db, 'engine.alerts');
  let count = 0;
  try {
    count = Number((JSON.parse(previous ?? '{}') as { count?: number }).count ?? 0);
  } catch {
    count = 0;
  }
  setMeta(deps.db, 'engine.alerts', JSON.stringify({ count: count + 1, last: alert }));
  deps.alert?.(alert);
}
