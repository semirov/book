/**
 * Shared plumbing for the engine modules: the clock seam (so leases, TTLs and budgets are
 * testable without sleeping), and the one error shape the internal API turns into a code
 * plus an HTTP status. The engine never throws a bare Error at a caller: every refusal has
 * a stable `code`, because the CLI and the session loop branch on it.
 */

import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';

export type Clock = { now(): number };

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Why a pass parked. A broken call (transport, answer shape, a gate that never answered) is not a
 * refusal of the work, and `premise.ts` settles a chapter's premise by this cause: a reader is
 * never told their intervention was declined because a gate call failed.
 */
export type PremiseCause = 'refused' | 'failed';

export class EngineError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: string, status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
    this.detail = detail ?? null;
  }
}

export function refuse(code: string, status: number, message: string, detail?: unknown): never {
  throw new EngineError(code, status, message, detail);
}

export type EngineDeps = {
  db: Db;
  config: Config;
  bookRoot: string;
  clock: Clock;
  /** Admin alerts (a finding that survived the cycle, a budget stop) are records, not logs. */
  alert?: (alert: EngineAlert) => void;
};

export type EngineAlert = {
  kind:
    | 'finding'
    | 'budget'
    | 'oscillation'
    | 'origin'
    | 'delta'
    | 'ending'
    /** BOOK-76: a physics claim failed the consultant and the change stopped. */
    | 'science'
    /** BOOK-61: Gate B refused a chapter's new prose and the step stopped. */
    | 'rights'
    | 'gate_timeout'
    /** BOOK-18: the derived index could not be built or written at a gate dispatch. */
    | 'index'
    /** BOOK-DOC-80: a sampled `local only` change disagreed with the editor, or the judge drifts. */
    | 'local_only';
  at: string;
  changeId: string | null;
  cascadeId: string | null;
  stepId: string | null;
  detail: string;
};

export function isEngineError(error: unknown): error is EngineError {
  return error instanceof EngineError;
}
