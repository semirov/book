/**
 * scripts/lib/position.mjs — the position harness's arithmetic and its record (BOOK-209).
 *
 * Two jobs, both pure and both testable without a browser:
 *
 *   - **the verdict**: which row missed the reading line, which back case lost the place, and
 *     therefore the process exit code the harness returns (0 / 1 — 2 belongs to a harness that
 *     could not run at all, and the driver raises that before this module is asked);
 *   - **the record**: `shots/position/<stage>.md`, the human table the owner reads, built from
 *     the same numbers the JSON carries, so the two can never disagree.
 *
 * The design constant lives here, once: AC1 is «the chapter's heading top sits at the sticky
 * head's **bottom + 16 px**» at every width, and a row is a miss outside ±2 px. The driver
 * imports it instead of restating a number per row.
 */

/** AC1: the reading line — the sticky head's bottom plus this, in CSS px. */
export const POSITION_TARGET_PX = 16;
/** AC1/AC2: the rounding a landing may carry without being a miss. */
export const POSITION_TOLERANCE_PX = 2;

/** Two decimals: a rect is fractional, and a table of 0.000001 differences is noise. */
export function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** The middle of a list of deltas; null when there is nothing to take the middle of. */
export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return round2(middle);
}

/** Did this row hold AC1 (a measured delta inside the tolerance)? */
export function rowHolds(row, tolerance = POSITION_TOLERANCE_PX) {
  return Number.isFinite(row.delta) && Math.abs(row.delta) <= tolerance;
}

/** Is `candidate` a worse place than the `current` worst? An unmeasured row beats a measured one. */
function isWorse(candidate, current) {
  if (current === null) return true;
  if (!Number.isFinite(current.delta)) return false;
  if (!Number.isFinite(candidate.delta)) return true;
  return Math.abs(candidate.delta) > Math.abs(current.delta);
}

/**
 * One bucket per width: how many rows hold, the median delta, and the worst row — the one with
 * the largest |delta|, because a table whose worst row is chosen by sign hides half the defect.
 */
export function summariseRows(rows, tolerance = POSITION_TOLERANCE_PX) {
  const order = [];
  const buckets = new Map();
  for (const row of rows) {
    if (!buckets.has(row.width)) {
      buckets.set(row.width, { width: row.width, count: 0, outside: 0, deltas: [], worst: null });
      order.push(row.width);
    }
    const bucket = buckets.get(row.width);
    bucket.count += 1;
    if (Number.isFinite(row.delta)) bucket.deltas.push(row.delta);
    if (!rowHolds(row, tolerance)) bucket.outside += 1;
    const candidate = { row: row.row, actual: row.actual, delta: row.delta, head: row.head };
    if (isWorse(candidate, bucket.worst)) bucket.worst = candidate;
  }
  return order.map((width) => {
    const bucket = buckets.get(width);
    return {
      width: bucket.width,
      count: bucket.count,
      outside: bucket.outside,
      median: median(bucket.deltas),
      worst: bucket.worst,
    };
  });
}

/** The back/forward cases that lost the place: not found, or further than the tolerance. */
export function backMisses(back, tolerance = POSITION_TOLERANCE_PX) {
  return back.filter((item) => item.found !== true || !Number.isFinite(item.delta) || Math.abs(item.delta) > tolerance);
}

/**
 * The resume verdict, **per device**: a device the harness never measured is `restored: null`
 * and is not a miss (the harness has no evidence, and silence is not a failure); a device it did
 * measure and that landed elsewhere is a miss. The server's own answer is reported beside them —
 * it is evidence about the route, not a substitute for a measured landing.
 */
export function resumeMisses(resume, tolerance = POSITION_TOLERANCE_PX) {
  if (resume === null || resume === undefined) return [];
  const misses = [];
  for (const [device, place] of [
    ['same-device', resume.sameDevice],
    ['second-device', resume.secondDevice],
  ]) {
    if (place === null || place === undefined) continue;
    // Only a boolean is a measurement; `null` is «the harness never got that far».
    if (place.restored !== true && place.restored !== false) continue;
    if (place.restored === true) continue;
    misses.push({ device, place });
  }
  // A device that keeps a place is a device whose layer exists: if the route behind it did not
  // answer, the signed-in half was never exercised, and «not measured» there is not a pass.
  const layerExists = resume.sameDevice !== null && resume.sameDevice !== undefined && resume.sameDevice.measured === true;
  if (layerExists && resume.server !== null && resume.server !== undefined && resume.server.outcome !== 'answered') {
    misses.push({ device: 'server', place: { status: resume.server } });
  }
  if (resume.pixels !== null && resume.pixels !== undefined && Math.abs(resume.pixels) > tolerance) {
    misses.push({ device: 'pixels', place: { delta: resume.pixels } });
  }
  return misses;
}

/**
 * The exit code, from the numbers only: 0 — every measured assertion holds; 1 — at least one
 * row, back case or (implemented) resume missed. A harness that never got this far exits 2.
 */
export function positionVerdict(report, tolerance = POSITION_TOLERANCE_PX) {
  const reasons = [];
  for (const width of summariseRows(report.rows, tolerance)) {
    if (width.outside > 0) {
      reasons.push(`${String(width.outside)}/${String(width.count)} row(s) outside ±${String(tolerance)} px at ${String(width.width)}`);
    }
  }
  for (const miss of backMisses(report.back, tolerance)) {
    const moved = Number.isFinite(miss.delta) ? `${miss.delta > 0 ? '+' : ''}${String(miss.delta)} px` : 'not found';
    reasons.push(`back case ${miss.case} lost the place (${moved})`);
  }
  for (const miss of resumeMisses(report.resume, tolerance)) {
    if (miss.device === 'server') {
      const status = miss.place.status;
      reasons.push(
        `the signed-in place was not exercised (${status.outcome}: anonymous=${String(status.anonymous)}, signed=${String(status.signed)})`,
      );
    } else {
      reasons.push(`resume (${miss.device}) did not restore the place`);
    }
  }
  return { code: reasons.length === 0 ? 0 : 1, reasons };
}

/** `-8.06` / `0` — a signed number in a table cell, never `NaN`. */
function cell(value) {
  if (value === null || value === undefined) return '—';
  return String(round2(value));
}

function table(head, rows) {
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

/**
 * Which book the run measured. The default is a fixture the run writes itself (`how: 'fixture'`)
 * — a generated `manuscript/` in a temp directory, deleted with the run — and the line says what
 * it held, because those counts are the only thing that tells the reader how different the page
 * was from the real book. A volume or a tree is named by its path.
 */
function seedLine(seed) {
  const fixture = seed.fixture;
  if (seed.how === 'fixture' && fixture !== undefined && fixture !== null) {
    return (
      `fixture — generated \`manuscript/\` in a temp dir (${String(fixture.files)} files, ` +
      `${String(fixture.chapters)} chapters, ${String(fixture.blocks)} blocks, ${String(fixture.bytes)} bytes), ` +
      'deleted with the run'
    );
  }
  return `${seed.how} \`${String(seed.source)}\``;
}

/**
 * The human record. Deterministic enough to diff between the before and the after run: the
 * commit, the tree, the summary per width, every row, the back cases and the resume answer.
 */
export function markdownReport(report, { stage = 'run' } = {}) {
  const verdict = positionVerdict(report);
  const summary = summariseRows(report.rows);
  const lines = [];
  lines.push(`# Position — ${stage}`, '');
  lines.push(`- commit: \`${report.commit}\` (branch \`${report.branch}\`)`);
  lines.push(`- taken: ${report.at}`);
  lines.push(`- target: **${String(report.target)} px** below the sticky head's bottom, tolerance ±${String(report.tolerance)} px`);
  const mode = report.freshPerRow === true ? 'each row on its own page load' : 'one document per width, reset to the top per row';
  lines.push(`- rows: ${String(report.rows.length)} (${report.widths.join(' / ')}), ${mode}`);
  if (report.budget !== undefined) {
    lines.push(
      `- read budget: READ_PER_MINUTE=${String(report.budget.readPerMinute)} — the limiter is not what this measures, ` +
        'and the sweep\'s own page loads must not starve the signed-in phase',
    );
  }
  const dirty = report.dirty;
  const shown = dirty.slice(0, 8).join(', ');
  const more = dirty.length > 8 ? ` … (+${String(dirty.length - 8)} more, named in the JSON)` : '';
  lines.push(`- tree: ${dirty.length === 0 ? 'clean' : `dirty — ${shown}${more}`}`);
  lines.push(`- browser: ${report.browser}`);
  if (report.source !== undefined) lines.push(`- source tree: \`${report.source}\``);
  if (report.seed !== undefined && report.seed !== null) {
    lines.push(`- seed: ${seedLine(report.seed)}`);
  }
  if (report.note !== undefined && report.note !== null) lines.push(`- note: ${report.note}`);
  lines.push('');

  lines.push('## Contents landing (AC1)', '');
  lines.push(
    table(
      ['width', 'rows', 'outside ±2 px', 'median delta', 'worst row', 'worst actual', 'worst delta'],
      summary.map((width) => [
        String(width.width),
        String(width.count),
        String(width.outside),
        cell(width.median),
        width.worst === null ? '—' : String(width.worst.row),
        width.worst === null ? '—' : cell(width.worst.actual),
        width.worst === null ? '—' : cell(width.worst.delta),
      ]),
    ),
    '',
  );

  lines.push('## Rows', '');
  lines.push(
    table(
      ['width', 'row', 'head', 'expected', 'actual', 'delta', 'at150', 'at800', 'stable'],
      report.rows.map((row) => [
        String(row.width),
        String(row.row),
        row.head,
        cell(row.expected),
        cell(row.actual),
        cell(row.delta),
        cell(row.at150),
        cell(row.at800),
        row.stable === true ? 'yes' : 'no',
      ]),
    ),
    '',
  );

  lines.push('## Back and forward (AC2)', '');
  if (report.back.length === 0) lines.push('_not measured_', '');
  else {
    const failed = backMisses(report.back);
    lines.push(
      table(
        ['width', 'case', 'via', 'sentence', 'before', 'after', 'delta', 'found'],
        report.back.map((item) => [
          item.width === undefined ? '—' : String(item.width),
          item.case,
          item.via ?? '—',
          `«${item.sentence}»`,
          cell(item.before),
          cell(item.after),
          cell(item.delta),
          item.found === true ? 'yes' : 'no',
        ]),
      ),
      '',
      failed.length === 0
        ? `${String(report.back.length)} case(s), none failed`
        : `${String(failed.length)} of ${String(report.back.length)} case(s) failed: ${failed
            .map((item) => (item.width === undefined ? item.case : `${item.case}@${String(item.width)}`))
            .join(', ')}`,
      '',
    );
  }

  lines.push('## Resume (AC3)', '');
  const server = report.resume.server;
  const serverText =
    server.outcome === 'answered'
      ? `answered (anonymous=${String(server.anonymous)}, signed=${String(server.signed)})`
      : server.outcome === 'guarded'
        ? `guarded (anonymous=${String(server.anonymous)}, signed=${String(server.signed)}) — the route answers only its reader`
        : `absent (anonymous=${String(server.anonymous)}, signed=${String(server.signed)}) — no /api/me/place`;
  lines.push(`- resume-server: ${serverText}`);
  if (report.resume.anchor === null) lines.push('- anchor: none — this device kept no place');
  else {
    const anchor = report.resume.anchor;
    lines.push(
      `- anchor: chapter ${String(anchor.chapter)}, \`${anchor.sentenceId}\`, delta=${cell(anchor.deltaPx)} px (the device's own row)`,
    );
  }
  lines.push(`- PUT /api/me/place: ${report.resume.put === null ? 'not attempted' : String(report.resume.put)}`, '');
  lines.push(
    table(
      ['device', 'top', 'sentence', 'before', 'after', 'delta', 'restored'],
      [
        ['same-device', report.resume.sameDevice],
        ['second-device', report.resume.secondDevice],
      ].map(([device, place]) => {
        if (place === null || place === undefined) return [device, '—', '—', '—', '—', '—', 'not measured'];
        const delta = Number.isFinite(place.before) && Number.isFinite(place.after) ? round2(place.after - place.before) : null;
        return [
          device,
          String(place.top),
          place.sentence === null ? 'none' : `«${place.sentence}»`,
          cell(place.before),
          cell(place.after),
          cell(delta),
          place.restored === true ? 'yes' : place.restored === false ? 'no' : 'not measured',
        ];
      }),
    ),
  );
  lines.push('');

  lines.push('## Verdict', '');
  lines.push(verdict.code === 0 ? 'exit 0 — every measured assertion holds' : `exit ${String(verdict.code)} — ${verdict.reasons.join('; ')}`);
  lines.push('');
  return lines.join('\n');
}
