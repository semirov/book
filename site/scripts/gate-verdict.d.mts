/**
 * Types for `scripts/gate-verdict.mjs` (BOOK-198) — the one required check, decided from
 * GitHub's `needs` object. Imported by `server/test/gateVerdict.test.ts`.
 */

export type NeedEntry = { result?: string; outputs?: Record<string, string> };

export type VerdictRow = { job: string; result: string; required: boolean; ok: boolean };

export type GateVerdict = {
  ok: boolean;
  mode: 'full' | 'affected';
  rows: VerdictRow[];
  reasons: string[];
};

export function verdict(needs: Record<string, NeedEntry>, event: string): GateVerdict;
