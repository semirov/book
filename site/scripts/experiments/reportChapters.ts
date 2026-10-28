/**
 * The per-chapter breakdown of a B row (BOOK-DOC-65 §6, extendendum): a ripple is a row per
 * chapter, so the table must show each chapter's own call, its money and its own verdicts.
 *
 * Read from the artifact, not from the log: the point patch is `point`, every ripple chapter is
 * `ripple.chapters[]`, and each one's gates are the `gates-…-ch<NN>-<role>.json` files the gate
 * pass wrote. A chapter that refused shows its code and no money it did not spend.
 */

import type { Artifact } from './store.ts';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function gate(byName: Map<string, Artifact>, label: string, chapter: number, role: 'editor' | 'consultant'): string {
  const artifact = byName.get(`gates-B-${label}-ch${String(chapter).padStart(2, '0')}-${role}.json`);
  const parsed = record(artifact?.parsed);
  if (parsed === null || parsed === undefined) return '—';
  if (parsed.ok === true) {
    const findings = Array.isArray(parsed.findings) ? parsed.findings.length : 0;
    return `${String(parsed.verdict)} (${String(findings)})`;
  }
  return String(parsed.code ?? 'GATE_UNPARSED');
}

type ChapterNumbers = {
  chapter: number | null;
  reason: string | null;
  in: number | null;
  out: number | null;
  cachedIn: number | null;
  usd: number | null;
  charsChanged: number | null;
  refusal: string | null;
};

function numbersOf(cell: Record<string, unknown> | null): Omit<ChapterNumbers, 'chapter' | 'reason'> {
  const metrics = record(cell?.metrics) ?? {};
  return {
    in: num(metrics.in),
    out: num(metrics.out),
    cachedIn: num(metrics.cachedIn),
    usd: num(metrics.usdPeak),
    charsChanged: num(metrics.charsChanged),
    refusal: typeof metrics.refusal === 'string' ? metrics.refusal : null,
  };
}

/** One line per chapter a B row patched: the point chapter first, then the ripple, in plan order. */
export function perChapter(
  byName: Map<string, Artifact>,
  label: string,
  artifactName = `ab-B-${label}.json`,
): Array<ChapterNumbers & { editor: string; consultant: string }> {
  const artifact = byName.get(artifactName);
  if (artifact === undefined) return [];
  const run = record(artifact.run) ?? {};
  const point = record(artifact.point);
  const rows: Array<ChapterNumbers & { editor: string; consultant: string }> = [];
  const push = (cell: Record<string, unknown> | null, chapter: number | null, reason: string | null): void => {
    const numbers = numbersOf(cell);
    rows.push({
      chapter,
      reason,
      ...numbers,
      editor: chapter === null ? '—' : gate(byName, label, chapter, 'editor'),
      consultant: chapter === null ? '—' : gate(byName, label, chapter, 'consultant'),
    });
  };
  if (point !== null) push(point, num(run.chapter), 'point patch');
  const ripple = record(artifact.ripple)?.chapters;
  if (Array.isArray(ripple)) {
    for (const entry of ripple) {
      const cell = record(entry);
      push(cell, num(cell?.chapter), typeof cell?.reason === 'string' ? cell.reason : null);
    }
  }
  return rows;
}

/**
 * The Markdown block, or an empty list when no B row patched more than its own chapter. The
 * control's artifact is named for its origin chapter, not for the filing's label, so it is read
 * with its own name and gated under `ctl05`.
 */
export function renderPerChapter(byName: Map<string, Artifact>, labels: readonly string[]): string[] {
  const lines: string[] = [];
  const groups: Array<{ label: string; artifactName?: string }> = labels.map((label) => ({ label }));
  if (byName.has('control-B-ch05.json')) groups.push({ label: 'ctl05', artifactName: 'control-B-ch05.json' });
  for (const group of groups) {
    const rows = perChapter(byName, group.label, group.artifactName);
    if (rows.length <= 1) continue;
    lines.push('', `**B ${group.label}**`, '', '| chapter | why | in | out | cached in | $ peak | chars changed | editor | consultant | refusal |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      lines.push(
        `| ${row.chapter === null ? '—' : String(row.chapter)} | ${row.reason ?? '—'} | ${row.in === null ? '—' : String(row.in)} | ${
          row.out === null ? '—' : String(row.out)
        } | ${row.cachedIn === null ? '—' : String(row.cachedIn)} | ${row.usd === null ? '—' : `$${row.usd.toFixed(4)}`} | ${
          row.charsChanged === null ? '—' : String(row.charsChanged)
        } | ${row.editor} | ${row.consultant} | ${row.refusal ?? '—'} |`,
      );
    }
  }
  return lines;
}

/**
 * The control's own block: what it is, what the plan said, and the two things the table cannot
 * hold — the promise it moves and the price of the ripple it implies, which is arithmetic on one
 * measured chapter and is labelled `computed`.
 */
export function renderControl(byName: Map<string, Artifact>): string[] {
  const artifact = byName.get('control-B-ch05.json');
  if (artifact === undefined) return [];
  const fixture = record(artifact.fixture) ?? {};
  const closure = record(artifact.closure) ?? {};
  const ripple = record(artifact.ripple) ?? {};
  const chapters = Array.isArray(ripple.chapters) ? (ripple.chapters as unknown[]) : [];
  const patchUsd = chapters.map((entry) => num(record(record(entry)?.metrics)?.usdPeak) ?? 0);
  const perChapter = patchUsd.length === 0 ? 0 : patchUsd.reduce((sum, value) => sum + value, 0) / patchUsd.length;
  const touched = Array.isArray(closure.chaptersTouched) ? (closure.chaptersTouched as unknown[]).length : 0;
  const projection = Math.round(perChapter * touched * 1_000_000) / 1_000_000;
  return [
    '',
    '### control — the seeded promise (`:memory:` ledger, real ch05/ch12 text, no filing, no DB write)',
    '',
    `promise: «${String(fixture.promise ?? '—')}» → «${String(fixture.promisedAfter ?? '—')}» · edge \`${String(
      fixture.edgeId ?? '—',
    )}\` · chapters [${Array.isArray(fixture.chapters) ? (fixture.chapters as unknown[]).join(', ') : '—'}]`,
    '',
    `ripple projection (computed): one measured patch ($${perChapter.toFixed(4)} peak) × ${String(
      touched,
    )} chapters the closure touches = **$${projection.toFixed(4)} peak** — arithmetic over a measured number, not an estimate.`,
  ];
}
