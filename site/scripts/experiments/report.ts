/**
 * `summary.json` and `summary.md` — the table the design note pastes (BOOK-DOC-65 §6).
 *
 * Built only from artifacts on disk, so a resumed run and a fresh run produce the same summary
 * for the same measurements, and a run stopped by the cap summarises exactly what it has.
 *
 * The A/B table carries §6's columns and adds the peak basis beside the book one: the note asks
 * for both sums, and one `$` column would hide which of the two the cap counted.
 */

import { writeFileSync } from 'node:fs';

import { listArtifacts, artifactPath, saveArtifact, type Artifact } from './store.ts';
import { CAP_USD, DATA_DIR, LABELS, PEAK_MULTIPLIER } from './spec.ts';

export type PinFacts = {
  model: string;
  apiModel: string;
  endpoint: string;
  rates: { per: number; input: number; output: number; cacheRead: number };
};

type Row = {
  run: string;
  mode: 'A' | 'B';
  filing: string;
  in: number | null;
  out: number | null;
  cachedIn: number | null;
  usdBook: number | null;
  usdPeak: number | null;
  wallMs: number | null;
  charsChanged: number | null;
  pctOfChapter: number | null;
  editor: string;
  consultant: string;
  untouchedHashEqual: boolean | null;
  refusal: string | null;
  blocked: string | null;
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function gateCell(artifacts: Map<string, Artifact>, mode: 'A' | 'B', label: string, role: string): string {
  const artifact = artifacts.get(`gates-${mode}-${label}-${role}.json`);
  if (artifact === undefined) return '—';
  const parsed = record(artifact.parsed);
  if (parsed === null) return '—';
  if (parsed.ok === true) {
    const findings = Array.isArray(parsed.findings) ? parsed.findings.length : 0;
    return `${String(parsed.verdict)} (${String(findings)})`;
  }
  return String(parsed.code ?? 'GATE_UNPARSED');
}

function rowFor(artifacts: Map<string, Artifact>, mode: 'A' | 'B', label: string): Row {
  const artifact = artifacts.get(`ab-${mode}-${label}.json`);
  const empty: Row = {
    run: `${mode} ${label}`,
    mode,
    filing: label,
    in: null,
    out: null,
    cachedIn: null,
    usdBook: null,
    usdPeak: null,
    wallMs: null,
    charsChanged: null,
    pctOfChapter: null,
    editor: gateCell(artifacts, mode, label, 'editor'),
    consultant: gateCell(artifacts, mode, label, 'consultant'),
    untouchedHashEqual: null,
    refusal: null,
    blocked: null,
  };
  if (artifact === undefined) return empty;
  const metrics = record(artifact.metrics) ?? {};
  const response = record(artifact.response) ?? {};
  const usage = record(response.usage) ?? {};
  return {
    ...empty,
    in: num(usage.in),
    out: num(usage.out),
    cachedIn: num(usage.cachedIn),
    usdBook: num(metrics.usdBook),
    usdPeak: num(metrics.usdPeak),
    wallMs: num(metrics.wallMs),
    charsChanged: num(metrics.charsChanged),
    pctOfChapter: num(metrics.pctOfChapter),
    untouchedHashEqual: typeof metrics.untouchedHashEqual === 'boolean' ? metrics.untouchedHashEqual : null,
    refusal: typeof metrics.refusal === 'string' ? metrics.refusal : null,
    blocked: typeof artifact.blocked === 'string' ? artifact.blocked : null,
  };
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)} %`;
}

function usd(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(4)}`;
}

function cells(row: Row): string {
  return [
    row.run,
    row.in === null ? '—' : String(row.in),
    row.out === null ? '—' : String(row.out),
    row.cachedIn === null ? '—' : String(row.cachedIn),
    usd(row.usdBook),
    usd(row.usdPeak),
    row.wallMs === null ? '—' : String(row.wallMs),
    row.charsChanged === null ? '—' : String(row.charsChanged),
    pct(row.pctOfChapter),
    row.editor,
    row.consultant,
    row.untouchedHashEqual === null ? '—' : row.untouchedHashEqual ? 'equal' : 'changed',
    row.blocked !== null ? `BLOCKED: ${row.blocked}` : (row.refusal ?? '—'),
  ].join(' | ');
}

export function writeSummary(input: {
  pin: PinFacts;
  spend: { calls: number; usdBook: number; usdPeak: number; capHit: boolean };
  startedAt: string;
  finishedAt: string;
}): { rows: number; cacheCalls: number; path: string } {
  const all = [
    ...listArtifacts('ab'),
    ...listArtifacts('gates'),
    ...listArtifacts('cache'),
    ...listArtifacts('smoke'),
  ];
  const byName = new Map(all.map((artifact) => [artifact.artifact, artifact]));

  const rows: Row[] = [];
  for (const label of LABELS) {
    for (const mode of ['A', 'B'] as const) rows.push(rowFor(byName, mode, label));
  }

  const cache = listArtifacts('cache')
    .map((artifact) => {
      const run = record(artifact.run) ?? {};
      const metrics = record(artifact.metrics) ?? {};
      return {
        artifact: artifact.artifact,
        variant: String(run.variant ?? '?'),
        title: String(run.title ?? ''),
        proves: String(run.proves ?? ''),
        call: num(metrics.call),
        promptTokens: num(metrics.promptTokens),
        cacheHit: num(metrics.cacheHit),
        cacheMiss: num(metrics.cacheMiss),
        prevPromptTokens: num(metrics.prevPromptTokens),
        hitRateVsPrevPrefix: num(metrics.hitRateVsPrevPrefix),
        refusal: typeof metrics.refusal === 'string' ? metrics.refusal : null,
      };
    })
    .sort((a, b) => `${a.variant}${String(a.call)}`.localeCompare(`${b.variant}${String(b.call)}`));

  const cacheCalls = cache.filter((entry) => entry.refusal === null).length;
  const gatesUsd = all
    .filter((artifact) => artifact.command === 'gates')
    .reduce((sum, artifact) => sum + (num(record(artifact.metrics)?.usdPeak) ?? 0), 0);

  const summary = {
    experiment: 'BOOK-173 A/B/C (BOOK-DOC-65 §6)',
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    pin: input.pin,
    rates: { ...input.pin.rates, peakMultiplier: PEAK_MULTIPLIER, currency: 'USD', per: input.pin.rates.per },
    cap: { usd: CAP_USD, basis: 'peak', hit: input.spend.capHit },
    spend: { ...input.spend, gatesUsdPeak: Math.round(gatesUsd * 1_000_000) / 1_000_000 },
    rows,
    cache,
    notes: [
      'A = the frozen today-order rewrite prompt (site/scripts/experiments/promptA.ts); B = the surgical patch.',
      'One attempt per mode: no retry, no repair; a refusal is a row.',
      'Gates read the whole chapter as in production; indexSlice is null (engine-derived, absent here).',
      'untouched hash = sha256 over the untouched blocks\' ids+hashes, pre vs post; the count is printed beside it.',
      '% of ch = changedChars / before.chars; changedChars = Σ max(|before|,|after|) over unaligned blocks.',
      'Hits are the provider\'s own counters (prompt_cache_hit_tokens / prompt_cache_miss_tokens).',
      "A is a frozen copy of the committed builder's order (promptA.ts): it was byte-identical to HEAD's buildWriterPrompt when written, and the shipped builder's reorder must not move an A row.",
      'The C prefix is canon + role + protocol as this book has them; its real size is the `prompt` column of call (i)/1, not the design note\'s estimate.',
    ],
    blocked: rows.filter((row) => row.blocked !== null).map((row) => `${row.run}: ${String(row.blocked)}`),
    artifacts: all.map((artifact) => artifact.artifact),
  };
  saveArtifact('summary.json', summary as unknown as Record<string, unknown>);

  const lines: string[] = [
    '# BOOK-173 A/B/C — measured (BOOK-DOC-65 §6)',
    '',
    `pin: \`${input.pin.model}\` (\`${input.pin.apiModel}\`) · ${input.pin.endpoint}`,
    `rates per ${String(input.pin.rates.per)}: in ${String(input.pin.rates.input)} · out ${String(input.pin.rates.output)} · cache-read ${String(input.pin.rates.cacheRead)} — peak = ${String(PEAK_MULTIPLIER)}×`,
    `spent: $${input.spend.usdBook.toFixed(4)} book · $${input.spend.usdPeak.toFixed(4)} peak · ${String(input.spend.calls)} calls · cap $${CAP_USD.toFixed(2)} (hit: ${input.spend.capHit ? 'yes — stopped' : 'no'})`,
    '',
    '## A/B',
    '',
    '| Run | in | out | cached in | $ book | $ peak | wall ms | chars changed | % of ch | editor | consultant | untouched hash | refusal |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${cells(row)} |`),
    '',
    'Gates: whole chapter, `indexSlice: null` (no engine here); verdict with findings count in parentheses.',
    '',
    '## C — the cache matrix',
    '',
    '| Variant | Call | prompt | cache hit | cache miss | hit rate vs largest prev prefix |',
    '| --- | --- | --- | --- | --- | --- |',
    ...cache.map(
      (entry) =>
        `| ${entry.title} | ${String(entry.call ?? '—')} | ${String(entry.promptTokens ?? '—')} | ${String(
          entry.cacheHit ?? '—',
        )} | ${entry.cacheMiss === -1 || entry.cacheMiss === null ? 'n/a' : String(entry.cacheMiss)} | ${
          entry.hitRateVsPrevPrefix === null ? '—' : `${(entry.hitRateVsPrevPrefix * 100).toFixed(1)} %`
        } |`,
    ),
    '',
    'A hit rate is `prompt_cache_hit_tokens / prompt_tokens` of the **largest prompt sent before this call** —',
    'the thing a cache is supposed to make free — not the share of this call.',
    '',
    '## What this run does not say',
    '',
    '- gates read the chapter without the engine\'s index slice: an editor that would have had a pointer did not get one;',
    '- one attempt per mode: a retry or a repair would have cost and possibly landed; the rows show what one attempt did;',
    `- artifacts under \`${DATA_DIR.replace(/^.*\/site\//u, 'site/')}\` are git-ignored evidence, not shipped files.`,
  ];
  if (summary.blocked.length > 0) {
    lines.push('', '## Blocked', '', ...summary.blocked.map((entry) => `- ${entry}`));
  }
  writeFileSync(artifactPath('summary.md'), `${lines.join('\n')}\n`, 'utf8');
  return { rows: rows.length, cacheCalls, path: artifactPath('summary.md') };
}
