/**
 * `summary.json` and `summary.md` — the tables the design note pastes (BOOK-DOC-65 §6, BOOK-DOC-75).
 *
 * Built only from artifacts on disk, so a resumed run and a fresh run produce the same summary for
 * the same measurements, and a run stopped by the cap summarises exactly what it has. Three tables:
 *
 *   · **A/B** — the §6 row: the writing call's tokens, money, wall time, the diff, the verdicts;
 *   · **ripple** — what the closure costs: nodes, chapters, mandatory/optional, patches, money,
 *     and the four invariants (the ledger closed, the frames, irreversible acts, the plan equal);
 *   · **C** — the cache matrix and, when a plan was `wide`, the measured one-chapter rewrite with
 *     its projection over every chapter the plan touched.
 *
 * `## verdict` is left with placeholders: the harness must not pre-write a verdict over its own
 * measurements.
 */

import { writeFileSync } from 'node:fs';

import { artifactPath, listArtifacts, saveArtifact, type Artifact } from './store.ts';
import { renderControl, renderPerChapter } from './reportChapters.ts';
import { callRecords, spendOf } from './usage.ts';
import { cacheRows } from './reportCache.ts';
import { frameOk } from './ledger.ts';
import { CAP_USD, DATA_DIR, LABELS, PEAK_MULTIPLIER } from './spec.ts';

export type PinFacts = {
  model: string;
  apiModel: string;
  endpoint: string;
  rates: { per: number; input: number; output: number; cacheRead: number };
};

export type LedgerFacts = { chapters: number; facts: number; edges: number; backfillMs: number };

type Row = {
  run: string;
  mode: 'A' | 'B';
  filing: string;
  chapter: number | null;
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
  closure: {
    nodes: number | null;
    edges: number | null;
    chapters: number | null;
    mandatory: number | null;
    optional: number | null;
    outcome: string | null;
    proven: boolean | null;
    walkMs: number | null;
    chaptersTouched: number[] | null;
    irreversible: number | null;
    planEqual: boolean | null;
  };
  patches: number | null;
  patchUsdPeak: number;
  patchWallMs: number;
  frames: boolean | null;
  irreversible: number | null;
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A gate cell. `not measured (budget)` is not a verdict: it means no gate answer exists for that
 * cell — either the call was never made or it was cut at the harness's old 8 000-token cap, which
 * was our limit and not the gate's opinion. `GATE_TRUNCATED` is the new, honest code for a call the
 * 24 000 cap cut in this run: the finish reason and the token counts are in the artifact.
 */
function gateCell(byName: Map<string, Artifact>, mode: 'A' | 'B', label: string, chapter: number | null, role: string): string {
  if (chapter === null) return 'not measured (budget)';
  const artifact = byName.get(`gates-${mode}-${label}-ch${String(chapter).padStart(2, '0')}-${role}.json`);
  if (artifact === undefined) return 'not measured (budget)';
  const parsed = record(artifact.parsed);
  if (parsed === null || parsed === undefined) return 'not measured (budget)';
  if (parsed.ok === true) {
    const findings = Array.isArray(parsed.findings) ? parsed.findings.length : 0;
    return `${String(parsed.verdict)} (${String(findings)})`;
  }
  if (parsed.code === 'GATE_TRUNCATED') return 'GATE_TRUNCATED';
  const finishReason = record(artifact.response)?.finishReason;
  // The 8 000-token cap of the earlier run: the gate was never allowed to answer.
  if (finishReason === 'length') return 'not measured (budget)';
  return String(parsed.code ?? 'GATE_UNPARSED');
}

function rowFor(byName: Map<string, Artifact>, mode: 'A' | 'B', label: string): Row {
  const artifact = byName.get(`ab-${mode}-${label}.json`);
  const empty: Row = {
    run: `${mode} ${label}`,
    mode,
    filing: label,
    chapter: null,
    in: null,
    out: null,
    cachedIn: null,
    usdBook: null,
    usdPeak: null,
    wallMs: null,
    charsChanged: null,
    pctOfChapter: null,
    editor: '—',
    consultant: '—',
    untouchedHashEqual: null,
    refusal: null,
    blocked: null,
    closure: { nodes: null, edges: null, chapters: null, mandatory: null, optional: null, outcome: null, proven: null, walkMs: null, chaptersTouched: null, irreversible: null, planEqual: null },
    patches: null,
    patchUsdPeak: 0,
    patchWallMs: 0,
    frames: null,
    irreversible: null,
  };
  if (artifact === undefined) return empty;

  const metrics = record(artifact.metrics) ?? {};
  const response = record(artifact.response) ?? {};
  const usage = record(response.usage) ?? {};
  const run = record(artifact.run) ?? {};
  const closure = record(artifact.closure) ?? {};
  const ripple = record(artifact.ripple) ?? {};
  const rippleChapters = Array.isArray(ripple.chapters) ? (ripple.chapters as unknown[]) : [];
  const chapter = num(run.chapter);
  const landed = record(artifact.landed);
  const landedText = typeof landed?.text === 'string' ? landed.text : null;
  const check = byName.get(`plancheck-${mode}-${label}.json`);
  const planEqual = typeof check?.planEqual === 'boolean' ? check.planEqual : null;

  return {
    ...empty,
    chapter,
    in: num(usage.in),
    out: num(usage.out),
    cachedIn: num(usage.cachedIn),
    usdBook: num(metrics.usdBook),
    usdPeak: num(metrics.usdPeak),
    wallMs: num(metrics.wallMs),
    charsChanged: num(metrics.charsChanged),
    pctOfChapter: num(metrics.pctOfChapter),
    editor: gateCell(byName, mode, label, chapter, 'editor'),
    consultant: gateCell(byName, mode, label, chapter, 'consultant'),
    untouchedHashEqual: typeof metrics.untouchedHashEqual === 'boolean' ? metrics.untouchedHashEqual : null,
    refusal: typeof metrics.refusal === 'string' ? metrics.refusal : null,
    blocked: typeof artifact.blocked === 'string' ? artifact.blocked : null,
    closure: {
      nodes: num(closure.closureNodes),
      edges: num(closure.closureEdges ?? (record(artifact.plan) ?? {}).closureEdges),
      chapters: num(closure.closureChapters),
      mandatory: num(closure.mandatory),
      optional: num(closure.optional),
      outcome: typeof closure.outcome === 'string' ? closure.outcome : null,
      proven: typeof closure.proven === 'boolean' ? closure.proven : null,
      walkMs: num(closure.walkMs),
      chaptersTouched: Array.isArray(closure.chaptersTouched) ? (closure.chaptersTouched as number[]) : null,
      irreversible: num(closure.irreversible),
      planEqual: planEqual ?? (typeof closure.planEqual === 'boolean' ? closure.planEqual : null),
    },
    patches: mode === 'B' ? 1 + rippleChapters.length : 1,
    patchUsdPeak: mode === 'B' ? (num(ripple.usdPeak) ?? 0) : 0,
    patchWallMs: mode === 'B' ? rippleWall(rippleChapters) : 0,
    frames: chapter === null || landedText === null ? null : frameOk(chapter, landedText),
    irreversible: num(closure.irreversible),
  };
}

/** The control's row: the seeded promise, its plan, the two patches it took. */
function controlRow(byName: Map<string, Artifact>): Row | null {
  const artifact = byName.get('control-B-ch05.json');
  if (artifact === undefined) return null;
  const check = byName.get('control-plan-after.json');
  const planEqual = typeof check?.planEqual === 'boolean' ? check.planEqual : null;
  const run = record(artifact.run) ?? {};
  const metrics = record(artifact.metrics) ?? {};
  const closure = record(artifact.closure) ?? {};
  const ripple = record(artifact.ripple) ?? {};
  const rippleChapters = Array.isArray(ripple.chapters) ? (ripple.chapters as unknown[]) : [];
  const chapter = num(run.chapter);
  const landed = record(artifact.landed);
  return {
    run: 'B control',
    mode: 'B',
    filing: 'ctl05',
    chapter,
    in: num(metrics.in),
    out: num(metrics.out),
    cachedIn: num(metrics.cachedIn),
    usdBook: num(metrics.usdBook),
    usdPeak: num(metrics.usdPeak),
    wallMs: num(metrics.wallMs),
    charsChanged: num(metrics.charsChanged),
    pctOfChapter: num(metrics.pctOfChapter),
    editor: gateCell(byName, 'B', 'ctl05', chapter, 'editor'),
    consultant: gateCell(byName, 'B', 'ctl05', chapter, 'consultant'),
    untouchedHashEqual: typeof metrics.untouchedHashEqual === 'boolean' ? metrics.untouchedHashEqual : null,
    refusal: typeof metrics.refusal === 'string' ? metrics.refusal : null,
    blocked: null,
    closure: {
      nodes: num(closure.closureNodes),
      edges: num(closure.closureEdges),
      chapters: num(closure.closureChapters),
      mandatory: num(closure.mandatory),
      optional: num(closure.optional),
      outcome: typeof closure.outcome === 'string' ? closure.outcome : null,
      proven: typeof closure.proven === 'boolean' ? closure.proven : null,
      walkMs: num(closure.walkMs),
      chaptersTouched: Array.isArray(closure.chaptersTouched) ? (closure.chaptersTouched as number[]) : null,
      irreversible: num(closure.irreversible),
      planEqual: planEqual ?? (typeof closure.planEqual === 'boolean' ? closure.planEqual : null),
    },
    patches: 1 + rippleChapters.length,
    patchUsdPeak: num(ripple.usdPeak) ?? 0,
    patchWallMs: rippleWall(rippleChapters),
    frames: chapter === null || typeof landed?.text !== 'string' ? null : frameOk(chapter, landed.text),
    irreversible: num(closure.irreversible),
  };
}

/** The wall time of every ripple patch in a row — summed, because the table shows the whole cost. */
function rippleWall(chapters: unknown[]): number {
  let wall = 0;
  for (const entry of chapters) {
    const value = num(record(record(entry)?.metrics)?.wallMs);
    if (value !== null) wall += value;
  }
  return wall;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)} %`;
}

function usd(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(4)}`;
}

function yes(flag: boolean | null, good: boolean): string {
  if (flag === null) return '—';
  return flag === good ? (good ? 'yes' : 'no') : (good ? 'no' : 'yes');
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

function rippleCells(row: Row): string {
  const closure =
    row.closure.nodes === null
      ? '—'
      : `${String(row.closure.nodes)}/${String(row.closure.edges ?? '—')}/${String(row.closure.chapters ?? '—')}`;
  const money = row.usdPeak === null ? null : row.usdPeak + row.patchUsdPeak;
  const wall = row.wallMs === null ? null : row.wallMs + row.patchWallMs;
  const chapters = row.closure.chaptersTouched === null ? '—' : `[${row.closure.chaptersTouched.join(', ')}]`;
  return [
    row.run,
    row.mode === 'A' && row.closure.outcome === 'wide' ? 'rewrite (not a patch)' : String(row.closure.outcome ?? '—'),
    closure,
    chapters,
    row.closure.mandatory === null ? '—' : String(row.closure.mandatory),
    row.closure.optional === null ? '—' : String(row.closure.optional),
    row.patches === null ? '—' : String(row.patches),
    usd(money),
    wall === null ? '—' : String(wall),
    row.closure.proven === null ? '—' : row.closure.proven ? 'closed' : 'open',
    yes(row.frames, true),
    row.irreversible === null ? '—' : row.irreversible === 0 ? 'none' : String(row.irreversible),
    row.closure.planEqual === null ? '—' : row.closure.planEqual ? 'equal' : 'moved',
    row.untouchedHashEqual === null ? '—' : row.untouchedHashEqual ? 'equal' : 'changed',
    row.refusal ?? '—',
  ].join(' | ');
}

export function writeSummary(input: {
  pin: PinFacts;
  spend: { calls: number; usdBook: number; usdPeak: number; capHit: boolean };
  startedAt: string;
  finishedAt: string;
  ledger?: LedgerFacts;
}): { rows: number; cacheCalls: number; path: string } {
  const all = [
    ...listArtifacts('ab'),
    ...listArtifacts('gates'),
    ...listArtifacts('cache'),
    ...listArtifacts('wide'),
    ...listArtifacts('control'),
    ...listArtifacts('plancheck'),
    ...listArtifacts('smoke'),
  ];
  const byName = new Map(all.map((artifact) => [artifact.artifact, artifact]));

  const rows: Row[] = [];
  for (const label of LABELS) {
    for (const mode of ['A', 'B'] as const) rows.push(rowFor(byName, mode, label));
  }
  const control = controlRow(byName);
  const rippleRows = control === null ? rows : [...rows, control];

  const cache = cacheRows();

  const wide = listArtifacts('wide').map((artifact) => {
    const run = record(artifact.run) ?? {};
    const metrics = record(artifact.metrics) ?? {};
    const response = record(artifact.response) ?? {};
    const validation = record(artifact.validation) ?? {};
    return {
      filing: String(run.filing ?? '—'),
      chapter: num(run.chapter),
      outcome: String(run.outcome ?? '—'),
      in: num(record(response.usage)?.in),
      out: num(record(response.usage)?.out),
      usdPeak: num(metrics.usdPeak),
      wallMs: num(metrics.wallMs),
      charsChanged: num(metrics.charsChanged),
      chaptersRewritten: num(metrics.chaptersRewritten),
      wideChapters: num(metrics.wideChapters),
      wideProjectionUsd: num(metrics.wideProjectionUsd),
      refusal: typeof metrics.refusal === 'string' ? metrics.refusal : validation.ok === false ? String(validation.code ?? '—') : null,
    };
  });

  const cacheCalls = cache.filter((entry) => entry.refusal === null).length;
  const wideUsd = wide.reduce((sum, entry) => sum + (entry.usdPeak ?? 0), 0);
  const records = callRecords();
  const money = spendOf(records, input.pin.rates); // artifacts, not `spend.json` (last-writer-wins)

  const summary = {
    experiment: 'BOOK-173 A/B/C (BOOK-DOC-65 §6, BOOK-DOC-75 ripple)',
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    pin: input.pin,
    rates: { ...input.pin.rates, peakMultiplier: PEAK_MULTIPLIER, currency: 'USD', per: input.pin.rates.per },
    cap: { usd: CAP_USD, basis: 'peak', hit: input.spend.capHit },
    spend: { ...money, wideUsdPeak: Math.round(wideUsd * 1_000_000) / 1_000_000, source: 'artifacts', capHit: input.spend.capHit },
    ledger: input.ledger ?? null,
    rows: rippleRows.map((row) => ({
      ...row,
      // The label, not the measurement: a rewrite's plan is `wide` because a rewrite moves more
      // than a ripple may, which is not a verdict about a patch.
      outcomeLabel: row.mode === 'A' && row.closure.outcome === 'wide' ? 'rewrite (not a patch)' : row.closure.outcome,
      usdPeakTotal: row.usdPeak === null ? null : row.usdPeak + row.patchUsdPeak,
    })),
    cache,
    wide,
    notes: [
      'A = the frozen today-order rewrite prompt (site/scripts/experiments/promptA.ts); B = point patch + the plan\'s mandatory chapters.',
      'The closure is whole-book and has no chapter window: buildPlan walks both directions from the filing\'s anchor facts.',
      'One attempt per call: no retry, no repair; a refusal is a row.',
      'Gates read the whole chapter as in production; indexSlice is null (engine-derived, absent here).',
      'untouched hash = sha256 over the untouched blocks\' ids+hashes, pre vs post; the count is in the artifact.',
      '% of ch = changedChars / before.chars; changedChars = Σ max(|before|,|after|) over unaligned blocks.',
      'The C prefix is canon + role + protocol as this book has them; its real size is the `prompt` column of call (i)/1.',
      'A wide row measures ONE rewritten chapter and projects it: wideProjectionUsd = perChapter × chapters.',
    ],
    blocked: rows.filter((row) => row.blocked !== null).map((row) => `${row.run}: ${String(row.blocked)}`),
    artifacts: all.map((artifact) => artifact.artifact),
  };
  saveArtifact('summary.json', summary as unknown as Record<string, unknown>);

  const lines: string[] = [
    '# BOOK-173 A/B/C — measured (BOOK-DOC-65 §6, BOOK-DOC-75)',
    '',
    `pin: \`${input.pin.model}\` (\`${input.pin.apiModel}\`) · ${input.pin.endpoint}`,
    `rates per ${String(input.pin.rates.per)}: in ${String(input.pin.rates.input)} · out ${String(input.pin.rates.output)} · cache-read ${String(input.pin.rates.cacheRead)} — peak = ${String(PEAK_MULTIPLIER)}×`,
    `spent: $${money.usdBook.toFixed(4)} book · $${money.usdPeak.toFixed(4)} peak · ${String(money.calls)} calls — recomputed from ${
      String(records.length)
    } recorded calls in ${String(new Set(records.map((call) => call.artifact)).size)} artifacts, one entry per call`,
    `cap: $${CAP_USD.toFixed(2)} peak, sticky (hit: ${input.spend.capHit ? 'yes — stopped' : 'no'}) · \`spend.json\` is the meter's working state, not the source of these numbers`,
    ...(input.ledger === undefined
      ? []
      : [
          `ledger: ${String(input.ledger.chapters)} chapters · ${String(input.ledger.facts)} facts · ${String(input.ledger.edges)} edges · backfilled in ${String(input.ledger.backfillMs)} ms (\`:memory:\`, whole book, no chapter window)`,
        ]),
    '',
    '## A/B',
    '',
    '| Run | in | out | cached in | $ book | $ peak | wall ms | chars changed | % of ch | editor | consultant | untouched hash | refusal |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${cells(row)} |`),
    '',
    'Gates: whole chapter, `indexSlice: null` (no engine here); verdict with findings count in parentheses.',
    '',
    'Cells marked `not measured (budget)` were never answered: the earlier A/B run used the harness\'s 8 000-token',
    'gate cap, which cut ten of twelve calls at `finish_reason: length` — our cap, not the gate\'s answer, so those',
    'cells stay unmeasured rather than shown as `GATE_UNPARSED`. The four ch06 cells were re-measured at 24 000.',
    'A `GATE_UNPARSED` that remains (ch06 A, editor) came back complete (`finish_reason: stop`, 10 212 out) and its',
    'finding lines exceeded `parseGateAnswer`\'s 600-character bound — the parser\'s limit, not the cap\'s.',
    '',
    '## ripple — what the closure costs',
    '',
    '| Run | outcome | closure (nodes/edges/ch) | chapters | mandatory | optional | patches | $ write+ripple | wall ms | ledger | frames | irreversible | plan | untouched | refusal |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rippleRows.map((row) => `| ${rippleCells(row)} |`),
    ...renderControl(byName),
    '',
    ...renderPerChapter(byName, LABELS),
    '',
    'Closure = the whole book, both directions, from the anchor facts. `mandatory 0` is a point patch and',
    'nothing else — a result, not a missing measurement. `ledger: open` = the plan could not bind its seeds',
    '(`proven: false`), the ledger\'s failure, never evidence of independence. `plan` = the closure at estimate',
    'against the one recomputed after the patches.',
    '',
    '## C — the cache matrix',
    '',
    'One baseline is warmed once (W1); every later call is measured **against it**. `hit / ref` =',
    '`prompt_cache_hit_tokens / referencePrefixTokens` (P0, or the lane prefix for H4). `expected` is the',
    'layout prediction, `reading` what happened.',
    '',
    '| # | Call | prompt | cache hit | cache miss | expected | hit / ref | proves | reading |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...cache.map(
      (entry) =>
        `| ${entry.call === null ? '—' : String(entry.call)} | ${entry.title} | ${
          entry.promptTokens === null ? '—' : String(entry.promptTokens)
        } | ${entry.cacheHit === null ? '—' : String(entry.cacheHit)} | ${
          entry.cacheMiss === null || entry.cacheMiss === -1 ? 'n/a' : String(entry.cacheMiss)
        } | ${entry.expected} | ${entry.hitRate === null ? '—' : `${(entry.hitRate * 100).toFixed(0)} %`} | ${
          entry.proves
        } | ${entry.reading} |`,
    ),
    '',
    'The finding is the opposite of §5\'s assumption: this prefix is **all or nothing**. Identical bytes hit',
    '99–100 %; a reordering, one appended style sentence, or a chapter placed inside the prefix all hit **0** —',
    'the part before the change is *not* recovered. So a dynamic block inside the prefix does not cost its tail,',
    'it costs the whole prefix (H3: 13 006 tokens, none cached).',
    '',
    'The one row a strict prefix does not predict is H4a (2 944 of 4 531): the lane prefix and P0 share bytes up',
    'to the protocol section, so a prefix match should have returned ~4 4xx tokens, not 2 944. Every prefix in',
    'this run carries the same run marker, so the hit is not a leftover of an earlier run. It is reported as',
    'measured and is not used in the conclusion: the rows that decide the layout question are W1, H0, H1, H2,',
    'H3 and H4b.',
    '',
    '## C — the wide row',
    '',
    '| Filing | chapter | plan | in | out | $ peak (one chapter) | wall ms | chars changed | chapters rewritten | chapters touched | projection $ peak (computed) | refusal |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(wide.length === 0
      ? ['| — | — | no wide plan in this run (`cache --control` seeds one) | — | — | — | — | — | — | — | — | — |']
      : wide.map(
          (entry) =>
            `| ${entry.filing} | ${entry.chapter === null ? '—' : String(entry.chapter)} | ${entry.outcome} | ${
              entry.in === null ? '—' : String(entry.in)
            } | ${entry.out === null ? '—' : String(entry.out)} | ${usd(entry.usdPeak)} | ${
              entry.wallMs === null ? '—' : String(entry.wallMs)
            } | ${entry.charsChanged === null ? '—' : String(entry.charsChanged)} | ${String(entry.chaptersRewritten ?? '—')} | ${String(
              entry.wideChapters ?? '—',
            )} | ${usd(entry.wideProjectionUsd)} | ${entry.refusal ?? '—'} |`,
        )),
    '',
    'One chapter is measured; the projection is `perChapter × chapters` — arithmetic over a measured number.',
    '',
    '## verdict',
    '',
    '> Placeholders on purpose: the orchestrator writes this after reading the tables above.',
    '',
    '- **default mode:** `<!-- TODO -->`',
    '- **expected cost per chapter:** `<!-- TODO -->`',
    '- **the one risk not to take:** `<!-- TODO -->`',
    '',
    '## What this run does not say',
    '',
    '- gates read the chapter without the engine\'s index slice, and each mode got one attempt: no retry, no repair;',
    `- artifacts under \`${DATA_DIR.replace(/^.*\/site\//u, 'site/')}\` are git-ignored evidence, not shipped files.`,
  ];
  if (summary.blocked.length > 0) {
    lines.push('', '## Blocked', '', ...summary.blocked.map((entry) => `- ${entry}`));
  }
  writeFileSync(artifactPath('summary.md'), `${lines.join('\n')}\n`, 'utf8');
  return { rows: rows.length, cacheCalls, path: artifactPath('summary.md') };
}
