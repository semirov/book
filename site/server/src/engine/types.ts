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
    | 'gate_timeout'
    /** BOOK-18: the derived index could not be built or written at a gate dispatch. */
    | 'index';
  at: string;
  changeId: string | null;
  cascadeId: string | null;
  stepId: string | null;
  detail: string;
};

export function isEngineError(error: unknown): error is EngineError {
  return error instanceof EngineError;
}
