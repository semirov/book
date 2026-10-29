/**
 * What the graph holds, chapter by chapter, for a person reading a terminal (BOOK-185).
 *
 * The report is a **measurement**, not a gate: it counts what the extraction actually wrote into
 * one database, so a change to a rule shows up as a different number instead of as an opinion.
 * Every count is a `GROUP BY` over the rows themselves — nothing here re-runs a recogniser, so a
 * report cannot disagree with the graph it describes.
 *
 * Since the model reads and code checks (BOOK-DOC-77 §5), the report also reads the run ledger:
 * what a chapter's rows were extracted by (`extracted_by`: the model and the prompt sha of its
 * latest completed run), how many runs it took, what they cost and what they refused, by code.
 * That is the only place the money and the rejects are visible without opening the database.
 */

import type { Db } from '../db/db.ts';
import { FACT_KINDS } from '../db/ledgerTables.ts';

export type ChapterReport = {
  chapter: number;
  basis: boolean;
  gap: number;
  facts: Record<string, number>;
  factsTotal: number;
  mentions: { assert: number; use: number };
  literals: number;
  threads: { strong: number; weak: number };
  edges: Record<string, number>;
  edgesTotal: number;
  runs: RunReport;
};

/** One pass of the ledger, on its own: the extractor's and the recall's tokens are separate money. */
export type PassReport = {
  runs: number;
  ok: number;
  refused: number;
  error: number;
  tokens: { in: number; out: number; cached: number };
  usd: number;
  rejects: Record<string, number>;
};

/** What the recall pass added to a chapter: the number «what did recall buy» answers with. */
export type RecallAddedReport = { facts: number; edges: number; threads: number };

/** The run ledger as one chapter reads it: how it was produced and what producing it cost. */
export type RunReport = {
  total: number;
  ok: number;
  refused: number;
  error: number;
  tokens: { in: number; out: number; cached: number };
  usd: number;
  /** Reject codes of every run of this chapter, counted. */
  rejects: Record<string, number>;
  /** The two passes, split: a recall question's tokens are not the extract question's. */
  passes: { extract: PassReport; recall: PassReport };
  /** The latest completed recall run's additions; zero when the recall never landed. */
  recallAdded: RecallAddedReport;
  /** The latest completed run: what `extracted_by` on this chapter's rows names. */
  last: { run: string; model: string; promptSha: string; at: string } | null;
};

export type ThreadReport = {
  id: string;
  label: string;
  direction: string;
  state: string;
  opened: number;
  closed: number | null;
  strong: boolean;
  events: Array<{ chapter: number; kind: string; factId: string | null }>;
};

export type GraphReport = {
  chapters: ChapterReport[];
  totals: {
    chapters: number;
    facts: number;
    factsByKind: Record<string, number>;
    mentions: { assert: number; use: number };
    literals: number;
    edges: number;
    edgesByKind: Record<string, number>;
    threads: { total: number; strong: number; weak: number };
    gap: number;
    runs: Omit<RunReport, 'last'>;
  };
  threads: ThreadReport[];
};

const EDGE_KINDS = ['cause', 'promise', 'document', 'absence', 'decision'] as const;

function emptyCounts(): Record<string, number> {
  return Object.fromEntries(FACT_KINDS.map((kind) => [kind, 0]));
}

function emptyPass(): PassReport {
  return { runs: 0, ok: 0, refused: 0, error: 0, tokens: { in: 0, out: 0, cached: 0 }, usd: 0, rejects: {} };
}

function emptyRuns(): RunReport {
  return {
    total: 0,
    ok: 0,
    refused: 0,
    error: 0,
    tokens: { in: 0, out: 0, cached: 0 },
    usd: 0,
    rejects: {},
    passes: { extract: emptyPass(), recall: emptyPass() },
    recallAdded: { facts: 0, edges: 0, threads: 0 },
    last: null,
  };
}

type GroupRow = { chapter: number; kind: string; n: number };

function groupByChapter(db: Db, sql: string): Map<number, Array<{ kind: string; n: number }>> {
  const rows = db.prepare(sql).all() as GroupRow[];
  const grouped = new Map<number, Array<{ kind: string; n: number }>>();
  for (const row of rows) {
    const list = grouped.get(row.chapter) ?? [];
    list.push({ kind: row.kind, n: row.n });
    grouped.set(row.chapter, list);
  }
  return grouped;
}

type RunRow = {
  id: string;
  chapter: number;
  model: string;
  promptSha: string;
  at: string;
  status: string;
  pass: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  usd: number;
  facts: number;
  edges: number;
  threads: number;
  rejects: string;
};

/** Reject codes of one run, read back from the row; a broken column counts as `UNREADABLE`. */
function rejectCodes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) =>
      typeof item === 'object' && item !== null && typeof (item as { code?: unknown }).code === 'string'
        ? String((item as { code: string }).code)
        : 'UNREADABLE',
    );
  } catch {
    return ['UNREADABLE'];
  }
}

/**
 * Every run, grouped by chapter. Rows are read in `(at, rowid)` order, so the last `ok` row seen
 * is the latest one — the same rule `runs.latestOkRun` applies, which is what keeps the report
 * from naming a different run than the one a reuse would answer with.
 */
function readRuns(db: Db): Map<number, RunReport> {
  const rows = db
    .prepare(
      `SELECT id, chapter, model, prompt_sha AS promptSha, at, status, pass,
              tokens_in AS tokensIn, tokens_out AS tokensOut, tokens_cached AS tokensCached, usd,
              facts, edges, threads, rejects
         FROM extraction_runs ORDER BY chapter, at, rowid`,
    )
    .all() as RunRow[];
  const grouped = new Map<number, RunReport>();
  for (const row of rows) {
    const report = grouped.get(row.chapter) ?? emptyRuns();
    const recall = row.pass === 'recall';
    const pass = recall ? report.passes.recall : report.passes.extract;
    report.total += 1;
    if (row.status === 'ok') report.ok += 1;
    else if (row.status === 'refused') report.refused += 1;
    else report.error += 1;
    pass.runs += 1;
    if (row.status === 'ok') pass.ok += 1;
    else if (row.status === 'refused') pass.refused += 1;
    else pass.error += 1;
    report.tokens.in += row.tokensIn;
    report.tokens.out += row.tokensOut;
    report.tokens.cached += row.tokensCached;
    report.usd += row.usd;
    pass.tokens.in += row.tokensIn;
    pass.tokens.out += row.tokensOut;
    pass.tokens.cached += row.tokensCached;
    pass.usd += row.usd;
    for (const code of rejectCodes(row.rejects)) {
      report.rejects[code] = (report.rejects[code] ?? 0) + 1;
      pass.rejects[code] = (pass.rejects[code] ?? 0) + 1;
    }
    // Rows are read in `(at, rowid)` order, so the last `ok` recall row is the latest addition.
    if (row.status === 'ok' && recall) {
      report.recallAdded = { facts: row.facts, edges: row.edges, threads: row.threads };
    }
    if (row.status === 'ok') {
      report.last = { run: row.id, model: row.model, promptSha: row.promptSha, at: row.at };
    }
    grouped.set(row.chapter, report);
  }
  const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  for (const report of grouped.values()) {
    report.usd = round(report.usd);
    report.passes.extract.usd = round(report.passes.extract.usd);
    report.passes.recall.usd = round(report.passes.recall.usd);
  }
  return grouped;
}

export type ThreadRow = {
  id: string;
  label: string;
  direction: string;
  state: string;
  opened_at_chapter: number;
  closed_at_chapter: number | null;
};

export type ThreadEventRow = { thread_id: string; chapter: number; kind: string; fact_id: string | null };

/**
 * The thread table as the report reads it: rows plus their state paths, in order. It moved here
 * when the deterministic thread builder was deleted — reading is not a rule, and the report is the
 * only reader.
 */
export function readThreads(
  db: Db,
): Array<ThreadRow & { events: Array<{ chapter: number; kind: string; factId: string | null }> }> {
  const threads = db
    .prepare(
      `SELECT id, label, direction, state, opened_at_chapter, closed_at_chapter
         FROM threads ORDER BY opened_at_chapter, id`,
    )
    .all() as ThreadRow[];
  const events = db
    .prepare(`SELECT thread_id, chapter, kind, fact_id FROM thread_events ORDER BY thread_id, chapter, id`)
    .all() as ThreadEventRow[];
  const byThread = new Map<string, Array<{ chapter: number; kind: string; factId: string | null }>>();
  for (const event of events) {
    const list = byThread.get(event.thread_id) ?? [];
    list.push({ chapter: event.chapter, kind: event.kind, factId: event.fact_id });
    byThread.set(event.thread_id, list);
  }
  return threads.map((thread) => ({ ...thread, events: byThread.get(thread.id) ?? [] }));
}

/** The whole graph as one object — the JSON `graph report --json` prints. */
export function buildReport(db: Db): GraphReport {
  const chapters = db
    .prepare(`SELECT n, basis, ledger_gap FROM chapters ORDER BY n`)
    .all() as Array<{ n: number; basis: number; ledger_gap: number }>;
  const facts = groupByChapter(db, `SELECT chapter, kind, COUNT(*) AS n FROM facts WHERE invalidated_at IS NULL AND superseded_by_extraction IS NULL GROUP BY chapter, kind`);
  const mentions = groupByChapter(db, `SELECT chapter, role AS kind, COUNT(*) AS n FROM mentions GROUP BY chapter, role`);
  const literals = groupByChapter(db, `SELECT chapter, 'literal' AS kind, COUNT(*) AS n FROM literals GROUP BY chapter`);
  const edges = groupByChapter(
    db,
    `SELECT chapter, kind, COUNT(*) AS n FROM fact_dependency
      WHERE superseded_by IS NULL AND retired_by_run IS NULL
      GROUP BY chapter, kind`,
  );
  const runs = readRuns(db);
  const threads = readThreads(db);
  const strong = new Set(
    threads
      .filter((thread) => thread.events.filter((event) => event.factId !== null).length >= 2)
      .map((thread) => thread.id),
  );

  const rows: ChapterReport[] = chapters.map((chapter) => {
    const byKind = emptyCounts();
    let factsTotal = 0;
    for (const entry of facts.get(chapter.n) ?? []) {
      byKind[entry.kind] = entry.n;
      factsTotal += entry.n;
    }
    const roleOf = (role: string): number =>
      (mentions.get(chapter.n) ?? []).filter((entry) => entry.kind === role).reduce((sum, entry) => sum + entry.n, 0);
    const edgeCounts: Record<string, number> = Object.fromEntries(EDGE_KINDS.map((kind) => [kind, 0]));
    let edgesTotal = 0;
    for (const entry of edges.get(chapter.n) ?? []) {
      edgeCounts[entry.kind] = entry.n;
      edgesTotal += entry.n;
    }
    const chapterThreads = threads.filter((thread) => thread.events.some((event) => event.chapter === chapter.n));
    return {
      chapter: chapter.n,
      basis: chapter.basis === 1,
      gap: chapter.ledger_gap,
      facts: byKind,
      factsTotal,
      mentions: { assert: roleOf('assert'), use: roleOf('use') },
      literals: (literals.get(chapter.n) ?? []).reduce((sum, entry) => sum + entry.n, 0),
      threads: {
        strong: chapterThreads.filter((thread) => strong.has(thread.id)).length,
        weak: chapterThreads.filter((thread) => !strong.has(thread.id)).length,
      },
      edges: edgeCounts,
      edgesTotal,
      runs: runs.get(chapter.n) ?? emptyRuns(),
    };
  });

  const factsByKind = emptyCounts();
  for (const row of rows) for (const [kind, n] of Object.entries(row.facts)) factsByKind[kind] = (factsByKind[kind] ?? 0) + n;
  const edgesByKind: Record<string, number> = Object.fromEntries(EDGE_KINDS.map((kind) => [kind, 0]));
  for (const row of rows) for (const [kind, n] of Object.entries(row.edges)) edgesByKind[kind] = (edgesByKind[kind] ?? 0) + n;
  const runTotals = emptyRuns();
  for (const row of rows) {
    runTotals.total += row.runs.total;
    runTotals.ok += row.runs.ok;
    runTotals.refused += row.runs.refused;
    runTotals.error += row.runs.error;
    runTotals.tokens.in += row.runs.tokens.in;
    runTotals.tokens.out += row.runs.tokens.out;
    runTotals.tokens.cached += row.runs.tokens.cached;
    runTotals.usd += row.runs.usd;
    runTotals.recallAdded.facts += row.runs.recallAdded.facts;
    runTotals.recallAdded.edges += row.runs.recallAdded.edges;
    runTotals.recallAdded.threads += row.runs.recallAdded.threads;
    for (const [code, n] of Object.entries(row.runs.rejects)) runTotals.rejects[code] = (runTotals.rejects[code] ?? 0) + n;
    for (const name of ['extract', 'recall'] as const) {
      const from = row.runs.passes[name];
      const into = runTotals.passes[name];
      into.runs += from.runs;
      into.ok += from.ok;
      into.refused += from.refused;
      into.error += from.error;
      into.tokens.in += from.tokens.in;
      into.tokens.out += from.tokens.out;
      into.tokens.cached += from.tokens.cached;
      into.usd += from.usd;
      for (const [code, n] of Object.entries(from.rejects)) into.rejects[code] = (into.rejects[code] ?? 0) + n;
    }
  }
  const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  const totalsRuns: Omit<RunReport, 'last'> = {
    total: runTotals.total,
    ok: runTotals.ok,
    refused: runTotals.refused,
    error: runTotals.error,
    tokens: runTotals.tokens,
    usd: round(runTotals.usd),
    rejects: runTotals.rejects,
    passes: {
      extract: { ...runTotals.passes.extract, usd: round(runTotals.passes.extract.usd) },
      recall: { ...runTotals.passes.recall, usd: round(runTotals.passes.recall.usd) },
    },
    recallAdded: runTotals.recallAdded,
  };
  return {
    chapters: rows,
    totals: {
      chapters: rows.length,
      facts: rows.reduce((sum, row) => sum + row.factsTotal, 0),
      factsByKind,
      mentions: {
        assert: rows.reduce((sum, row) => sum + row.mentions.assert, 0),
        use: rows.reduce((sum, row) => sum + row.mentions.use, 0),
      },
      literals: rows.reduce((sum, row) => sum + row.literals, 0),
      edges: rows.reduce((sum, row) => sum + row.edgesTotal, 0),
      edgesByKind,
      threads: { total: threads.length, strong: strong.size, weak: threads.length - strong.size },
      gap: rows.reduce((sum, row) => sum + row.gap, 0),
      runs: totalsRuns,
    },
    threads: threads.map((thread) => ({
      id: thread.id,
      label: thread.label,
      direction: thread.direction,
      state: thread.state,
      opened: thread.opened_at_chapter,
      closed: thread.closed_at_chapter,
      strong: strong.has(thread.id),
      events: thread.events,
    })),
  };
}

/** `$0.001234` — the money rounded to six places, which is the precision a run is charged at. */
function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** `QUOTE_NOT_FOUND=3 VALUE_UNPARSEABLE=1`, or `none`. */
function rejectLine(rejects: Record<string, number>): string {
  const entries = Object.entries(rejects).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? 'none' : entries.map(([code, n]) => `${code}=${String(n)}`).join(' ');
}

/** The report as a terminal table: one line per chapter, then the totals and the threads. */
export function renderReport(report: GraphReport): string[] {
  const lines: string[] = [];
  const header = [
    'ch', 'facts', 'date', 'doc', 'name', 'term', 'prom', 'dec', 'abs', 'a/u', 'lit', 'thr s/w', 'edges', 'gap',
    'runs', 'usd', 'by',
  ];
  lines.push(header.join('\t'));
  for (const row of report.chapters) {
    const last = row.runs.last;
    lines.push(
      [
        String(row.chapter).padStart(2, '0'),
        String(row.factsTotal),
        String(row.facts.date ?? 0),
        String(row.facts.document ?? 0),
        String(row.facts.name ?? 0),
        String(row.facts.term ?? 0),
        String(row.facts.promise ?? 0),
        String(row.facts.decision ?? 0),
        String(row.facts.absence ?? 0),
        `${String(row.mentions.assert)}/${String(row.mentions.use)}`,
        String(row.literals),
        `${String(row.threads.strong)}/${String(row.threads.weak)}`,
        String(row.edgesTotal),
        String(row.gap),
        String(row.runs.total),
        usd(row.runs.usd),
        last === null ? '—' : `${last.model}@${last.promptSha.slice(0, 8)}`,
      ].join('\t'),
    );
    if (row.runs.refused + row.runs.error > 0) {
      lines.push(
        `   ch${String(row.chapter).padStart(2, '0')} runs: ok ${String(row.runs.ok)}, ` +
          `refused ${String(row.runs.refused)}, error ${String(row.runs.error)} — rejects ${rejectLine(row.runs.rejects)}`,
      );
    }
    if (row.runs.passes.recall.runs > 0) {
      const extract = row.runs.passes.extract;
      const recall = row.runs.passes.recall;
      lines.push(
        `   ch${String(row.chapter).padStart(2, '0')} recall: +${String(row.runs.recallAdded.facts)} facts, ` +
          `+${String(row.runs.recallAdded.edges)} edges, +${String(row.runs.recallAdded.threads)} threads · ` +
          `extract ${String(extract.tokens.in)}/${String(extract.tokens.out)} · ` +
          `recall ${String(recall.tokens.in)}/${String(recall.tokens.out)} (in/out) · ` +
          `${usd(extract.usd)} + ${usd(recall.usd)}`,
      );
    }
  }
  const totals = report.totals;
  const byKind = FACT_KINDS.map((kind) => `${kind}=${String(totals.factsByKind[kind] ?? 0)}`).join(' ');
  lines.push(`facts ${String(totals.facts)} — ${byKind}`);
  lines.push(`mentions assert=${String(totals.mentions.assert)} use=${String(totals.mentions.use)} literals=${String(totals.literals)}`);
  lines.push(
    `edges ${String(totals.edges)} — ${EDGE_KINDS.map((kind) => `${kind}=${String(totals.edgesByKind[kind] ?? 0)}`).join(' ')}`,
  );
  lines.push(
    `threads ${String(totals.threads.total)} — strong ${String(totals.threads.strong)}, weak ${String(totals.threads.weak)}`,
  );
  lines.push(
    `runs ${String(totals.runs.total)} — ok ${String(totals.runs.ok)}, refused ${String(totals.runs.refused)}, ` +
      `error ${String(totals.runs.error)} — tokens ${String(totals.runs.tokens.in)}/${String(totals.runs.tokens.out)}/` +
      `${String(totals.runs.tokens.cached)} (in/out/cached) — ${usd(totals.runs.usd)}`,
  );
  lines.push(`rejects ${rejectLine(totals.runs.rejects)}`);
  const extractPass = totals.runs.passes.extract;
  const recallPass = totals.runs.passes.recall;
  lines.push(
    `recall added ${String(totals.runs.recallAdded.facts)} facts, ${String(totals.runs.recallAdded.edges)} edges, ` +
      `${String(totals.runs.recallAdded.threads)} threads — extract tokens ` +
      `${String(extractPass.tokens.in)}/${String(extractPass.tokens.out)}, recall tokens ` +
      `${String(recallPass.tokens.in)}/${String(recallPass.tokens.out)} (in/out) — ` +
      `${usd(extractPass.usd)} + ${usd(recallPass.usd)}`,
  );
  for (const thread of report.threads) {
    const path = thread.events.map((event) => `${String(event.chapter)}:${event.kind}`).join(' → ');
    lines.push(`  ${thread.strong ? '●' : '○'} ${thread.label} [${thread.direction}] ${path}`);
  }
  lines.push(`ledger_gap ${String(totals.gap)}`);
  return lines;
}
