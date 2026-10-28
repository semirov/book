/**
 * `## Tier 1 vs the pair` (BOOK-173, BOOK-DOC-80): the local judge's own price, measured twice.
 *
 * The reference is the full pair — the editor and the consultant on one chapter — at `$0.034` and
 * `~174 s`, the numbers the ch06 measurement gave. The tier is only worth its own row if it is
 * cheaper by a factor the table shows; a ratio computed from two measured numbers, so it is marked
 * `computed` like every other derived figure.
 */

import type { Artifact } from './store.ts';

/** The pair as measured on the ch06 run: two gate calls, one editor and one consultant. */
export const PAIR_USD_PEAK = 0.034;
export const PAIR_WALL_MS = 174_000;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function tier1Section(byName: Map<string, Artifact>): string[] {
  const artifact = byName.get('tier1-ch01.json');
  if (artifact === undefined) return [];
  const request = record(artifact.request) ?? {};
  const rows = Array.isArray(artifact.rows) ? (artifact.rows as Array<Record<string, unknown>>) : [];
  const spent = record(artifact.spent) ?? {};
  const total = num(spent.usdPeak) ?? 0;
  const first = rows[0] ?? {};
  const second = rows[1] ?? {};
  const wall = rows.reduce((sum, row) => sum + (num(row.wallMs) ?? 0), 0);
  const hit = num(second.cachedIn) ?? 0;
  const base = num(first.in) ?? 0;
  const ratio = total > 0 ? PAIR_USD_PEAK / total : 0;

  const lines = [
    '',
    '## Tier 1 vs the pair',
    '',
    `prompt: system ${String(num(request.systemChars) ?? 0)} ch (~${String(
      Math.ceil((num(request.systemChars) ?? 0) / 3),
    )} tok prefix) · tail ${String(num(request.userChars) ?? 0)} ch (~${String(
      Math.ceil((num(request.userChars) ?? 0) / 3),
    )} tok) · ${String(num(request.facts) ?? 0)} facts · span ${String(num(request.spanChars) ?? 0)} ch · prefix ${String(
      request.prefixSha256 ?? '—',
    ).slice(0, 12)}`,
    '',
    '| Call | in | out | cached in | $ book | $ peak | wall ms | verdict | findings |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${String(num(row.call) ?? '—')} | ${String(num(row.in) ?? '—')} | ${String(num(row.out) ?? '—')} | ${String(
          num(row.cachedIn) ?? '—',
        )} | ${(num(row.usdBook) ?? 0).toFixed(5)} | ${(num(row.usdPeak) ?? 0).toFixed(5)} | ${String(
          num(row.wallMs) ?? '—',
        )} | ${String(row.verdict ?? row.refusal ?? '—')} | ${String(num(row.findings) ?? 0)} |`,
    ),
    '',
    `Tier 1, two calls: **$${total.toFixed(5)} peak · ${String(wall)} ms** · cache on call 2: **${String(hit)} of ${String(
      base,
    )} tokens (${base === 0 ? 0 : Math.round((hit / base) * 100)} %)**.`,
    `The pair (editor + consultant, ch06 run): **$${PAIR_USD_PEAK.toFixed(3)} · ~${String(
      Math.round(PAIR_WALL_MS / 1000),
    )} s**. Ratio (computed): Tier 1 costs **1/${ratio.toFixed(1)}** of the pair and takes **1/${(
      PAIR_WALL_MS / Math.max(1, wall)
    ).toFixed(1)}** of its wall time.`,
  ];
  // This run's own pair, for a ratio against a number the table can be checked against.
  const own: Array<{ mode: string; usd: number }> = ['A', 'B'].map((mode) => {
    let sum = 0;
    for (const role of ['editor', 'consultant']) {
      const gate = byName.get(`gates-${mode}-ch06-ch06-${role}.json`);
      sum += num(record(gate?.metrics)?.usdPeak) ?? 0;
    }
    return { mode, usd: Math.round(sum * 1_000_000) / 1_000_000 };
  });
  const cheapest = Math.min(...own.filter((entry) => entry.usd > 0).map((entry) => entry.usd));
  const ownLine =
    Number.isFinite(cheapest) && total > 0
      ? `In this run the ch06 pair measured ${own
          .map((entry) => `$${entry.usd.toFixed(4)} (${entry.mode})`)
          .join(' and ')} — Tier 1 is 1/${(cheapest / total).toFixed(1)} of the cheaper pair.`
      : null;
  if (ownLine !== null) lines.push(ownLine);

  const missing = artifact.missing;
  if (typeof missing === 'string') lines.push('', `Not measured: ${missing}`);
  // The section ends with a blank so the next heading keeps its space without costing report.ts a line.
  lines.push('');
  return lines;
}
