/**
 * The experiment's spend, recomputed from its own artifacts (BOOK-DOC-65 §6).
 *
 * `spend.json` is a convenience the meter writes after every call, and it is **last-writer-wins**:
 * two harness processes (the A/B run and the cache/gates run) each write their own running total,
 * so the file under-counts whoever wrote first. The artifacts cannot drift that way — each one is
 * written once, by one process, and carries the call's own `usage` — so the summary's money is
 * summed here, per call, and `spend.json` is only the meter's working state.
 *
 * One artifact may hold more than one call (`ab-B-*`: the point patch plus every ripple chapter),
 * so the walk counts each call once and never the same rows twice.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { artifactPath } from './store.ts';
import { costOf, type Rates } from './metrics.ts';

export type CallRecord = {
  /** `<artifact>#<n>` — several calls can live in one artifact, so the id is the pair. */
  id: string;
  artifact: string;
  kind: string;
  in: number;
  out: number;
  cachedIn: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Every call any artifact of this experiment records, in file-name order. */
export function callRecords(): CallRecord[] {
  const names = (() => {
    try {
      return readdirSync(artifactPath('')).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
  })();
  const records: CallRecord[] = [];
  for (const name of names) {
    // The summary is a reading of the others; the meter's own file is not a call either.
    if (name === 'summary.json' || name === 'spend.json') continue;
    let artifact: Record<string, unknown> | null = null;
    try {
      artifact = record(JSON.parse(readFileSync(artifactPath(name), 'utf8')));
    } catch {
      continue;
    }
    if (artifact === null) continue;
    const kind = String(artifact.command ?? 'unknown');
    const usage = (value: unknown): { in: number; out: number; cachedIn: number } | null => {
      const cell = record(value);
      if (cell === null) return null;
      const tokens = record(cell.usage) ?? cell;
      const inTokens = count(tokens.in);
      if (inTokens === 0) return null;
      return { in: inTokens, out: count(tokens.out), cachedIn: count(tokens.cachedIn) };
    };

    const calls: Array<ReturnType<typeof usage>> = [];
    if (kind === 'cache') calls.push(usage(record(artifact.metrics)?.usage));
    else if (kind === 'gates' || kind === 'smoke' || kind === 'wide') calls.push(usage(artifact.response));
    else if (kind === 'ab' || kind === 'control') {
      calls.push(usage(artifact.response));
      const chapters = record(artifact.ripple)?.chapters;
      if (Array.isArray(chapters)) for (const chapter of chapters) calls.push(usage(record(chapter)?.response));
    }

    calls.forEach((call, index) => {
      if (call === null || call.in === 0) return;
      records.push({ id: `${name}#${String(index)}`, artifact: name, kind, ...call });
    });
  }
  return records;
}

export function spendOf(records: readonly CallRecord[], rates: Rates): { calls: number; usdBook: number; usdPeak: number } {
  let usdBook = 0;
  let usdPeak = 0;
  for (const call of records) {
    const usage = { in: call.in, out: call.out, cachedIn: call.cachedIn };
    usdBook += costOf(usage, rates, 1);
    usdPeak += costOf(usage, rates, 2);
  }
  return {
    calls: records.length,
    usdBook: Math.round(usdBook * 1_000_000) / 1_000_000,
    usdPeak: Math.round(usdPeak * 1_000_000) / 1_000_000,
  };
}
