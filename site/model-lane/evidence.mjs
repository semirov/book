/**
 * The transcript (ADR-038 §9): what a live run cost, and what it answered.
 *
 * One file per run in `site/test/model-evidence/`, committed: verdicts, hashes, usage, latency
 * and cost — **no prose, no findings text, no reader data**. The provider's own `response.model`
 * sits beside the declared one, which is what makes «we tested it on Pro» checkable instead of
 * remembered. A `.data/` file would be gitignored and therefore unverifiable; that is why the
 * directory is inside `test/` and holds only JSON (`arch.mjs` reads sources, not evidence).
 *
 * The cost formula lives here, once, and is priced only from `pipeline.json`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { BOOK_ROOT, SITE_ROOT } from './pipeline.mjs';

export const EVIDENCE_DIR = join(SITE_ROOT, 'test', 'model-evidence');

/** The answer's hash: the transcript records what was said without recording what it said. */
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `2026-10-28T09-12-00Z`: a UTC stamp that is also a legal file name. */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/:/gu, '-');
}

/** `2026-10-28T09-12-00Z-7f3a` — the ADR's run id: the stamp plus four hex characters. */
export function newRunId(date = new Date()) {
  return `${utcStamp(date)}-${randomBytes(2).toString('hex')}`;
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * `((in - cachedIn) × input + cachedIn × cacheRead + out × output) / per`, rounded to six
 * decimals per call. A cache read is cheaper than an input token, so it is priced apart.
 */
export function costUsd(usage, pricing) {
  const inTokens = Math.max(0, Number(usage?.in ?? 0));
  const cachedIn = Math.min(inTokens, Math.max(0, Number(usage?.cachedIn ?? 0)));
  const outTokens = Math.max(0, Number(usage?.out ?? 0));
  const amount = ((inTokens - cachedIn) * pricing.input + cachedIn * pricing.cacheRead + outTokens * pricing.output) / pricing.per;
  return round6(amount);
}

/**
 * The commit and whether the tree was dirty, read once at the start of a run from the **repo**
 * (read-only). Never a failure of the run: no git means `null`/`null`, and the transcript says so.
 * The short form is only for the printed line; the file keeps the full sha.
 */
export function readProvenance() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: BOOK_ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: BOOK_ROOT, encoding: 'utf8' }).trim().length > 0;
    return { commit: commit.length === 0 ? null : commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** `commit abc1234 · dirty true` — the one line a run prints about where it came from. */
export function provenanceLine(origin) {
  const short = origin.commit === null ? '—' : origin.commit.slice(0, 7);
  return `commit ${short} · dirty ${origin.dirty === null ? '—' : String(origin.dirty)}`;
}

/** Totals are a projection of the calls: runnable, blocked, ok, mismatch, tokens, cost. */
export function totalsOf(calls, origin = readProvenance()) {
  const total = {
    runnable: 0,
    blocked: 0,
    ok: 0,
    mismatch: 0,
    error: 0,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  for (const call of calls) {
    if (call.status === 'blocked') {
      total.blocked += 1;
      continue;
    }
    total.runnable += 1;
    if (call.status === 'ok') total.ok += 1;
    if (call.status === 'mismatch') total.mismatch += 1;
    if (call.status === 'error') total.error += 1;
    total.tokensIn += call.usage?.in ?? 0;
    total.tokensOut += call.usage?.out ?? 0;
    total.costUsd += call.costUsd ?? 0;
  }
  total.costUsd = round6(total.costUsd);
  return { total, commit: origin.commit, dirty: origin.dirty };
}

/**
 * The transcript document itself: pure over its arguments (provenance is injected), so the
 * assembly can be exercised — and its size measured — without a provider and without a file.
 *
 * `origin` is `{commit, dirty}` read **once** at the start of the run: a git call inside the
 * writer would race the run's own files, and a default of nulls is how the live transcripts came
 * out with `"commit": null` (BOOK-62, 2026-10-27). The summary is the same document minus the
 * per-call rows, so both files carry the fields.
 */
export function buildEvidence({
  run,
  runId,
  startedAt,
  finishedAt,
  pipeline,
  calls,
  extra = {},
  origin = readProvenance(),
  totals = null,
}) {
  const sum = totals ?? totalsOf(calls, origin);
  const document = {
    run,
    runId,
    startedAt,
    finishedAt,
    commit: sum.commit,
    dirty: sum.dirty,
    pipeline: { provider: pipeline.provider, model: pipeline.model, apiModel: pipeline.apiModel },
    ...extra,
    calls,
    totals: sum.total,
  };
  return {
    document,
    summary: { ...document, calls: undefined, callCount: calls.length },
    runId: document.runId,
    totals: sum.total,
  };
}

/**
 * Write run and summary files. `dir` exists so a proof can write into a temp directory; the
 * lane always uses the committed `site/test/model-evidence/`. The run file is written **first**:
 * a paid run must never end with zero bytes because the summary or the print failed after it.
 */
export function writeEvidence({ mode, dir = EVIDENCE_DIR, ...input }) {
  mkdirSync(dir, { recursive: true });
  // `mode` names the kind of run when the caller does not pass `run` (`corpus`|`pass`).
  const built = buildEvidence({ run: mode, ...input });
  // One name: the run id already starts with the UTC stamp, so `<runId>.json` says when it ran
  // once, not twice (review, nit 10).
  const path = join(dir, `${built.runId}.json`);
  writeFileSync(path, `${JSON.stringify(built.document, null, 2)}\n`, 'utf8');
  const summaryPath = join(dir, `${built.runId}.summary.json`);
  writeFileSync(summaryPath, `${JSON.stringify(built.summary, null, 2)}\n`, 'utf8');
  return { path, summaryPath, totals: built.totals };
}

/**
 * The transcript of a run that failed **after** it had already spent money. The calls that did
 * happen are the paid facts; writing them before the process exits is what keeps «we tested it»
 * checkable when a pass dies mid-way (BOOK-62, 2026-10-27: an empty writer lost a paid answer).
 * Nothing is invented for a call that never happened — a run with no answered call writes nothing.
 */
export function writeFailureTranscript({ mode, state, code, dir = EVIDENCE_DIR }) {
  if (state === null || state.written === true) return null;
  if (!state.calls.some((call) => call.usage !== undefined)) return null;
  try {
    const written = writeEvidence({
      mode,
      dir,
      runId: state.runId,
      run: mode,
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      pipeline: state.pipeline,
      calls: state.calls,
      origin: state.origin,
      extra: { failed: code, trace: { closed: false } },
    });
    return written.path;
  } catch (error) {
    console.error(`model-lane: could not write evidence for the failed run: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
