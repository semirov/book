/**
 * The ledger of the extraction itself (BOOK-185, BOOK-DOC-77 §5): one row per model call.
 *
 * Three decisions live here. **The question is the lookup, not the identity.** `(chapter, rev,
 * text_sha, prompt_sha, model, pass)` is a plain index: it answers «has this question been asked
 * and answered?», and reuse reads the **latest** `status = 'ok'` row for it. **A run is
 * append-only.** Every recorded run gets a fresh `run_` id — the n-th run of a question — so a
 * forced re-ask keeps the previous raw answer, which is what «supersede, never overwrite» means
 * for the audit; the rows a run wrote keep naming their own id through `extracted_by`.
 *
 * **The money is the pin's.** `usd` is computed from `pipeline.pricing` at the run's own token
 * counts — input at the input rate, the cached part of the input at the cache-read rate (a cached
 * token is charged once, at its own price, not twice), output at the output rate — and rounded to
 * six places like the writer's cost line.
 */

import type { Db } from '../db/db.ts';
import type { Pipeline } from '../pipeline.ts';
import type { Reject } from './judged.ts';
import type { ModelUsage } from './model.ts';
import { idOf } from './text.ts';

export type Question = {
  chapter: number;
  rev: number;
  textSha: string;
  promptSha: string;
  model: string;
  pass: 'extract' | 'recall';
};

/** The counts a stored run carries; a reuse answers with these and calls no model. */
export type RunCounts = { facts: number; uses: number; edges: number; threads: number };

export type RunWrite = {
  status: 'ok' | 'refused' | 'error';
  at: string;
  requestSha: string;
  response: string;
  usage: ModelUsage;
  usd: number;
  counts: RunCounts;
  rejects: readonly Reject[];
  /** The code of a refusal or a transport failure; null when the run was written. */
  error: string | null;
};

/** The stored `ok` run reuse answers from: its counts, its rejects and what it cost. */
export type OkRun = RunCounts & {
  id: string;
  model: string;
  promptSha: string;
  at: string;
  usage: ModelUsage;
  usd: number;
  rejects: Reject[];
  /**
   * The raw answer. Reuse of a recall question needs it: the recall prompt is built from the
   * first pass's answer, so the extract run's stored text is what names the next question.
   */
  response: string;
};

/** The run's reject list as stored; a hand-written row with a broken column contributes none. */
function rejectsOf(raw: string): Reject[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Reject[]) : [];
  } catch {
    return [];
  }
}

/**
 * How much of a **refused or failed** answer is kept: 200 KB of raw text is a diagnosis (where the
 * answer started, and that it never closed), and the rest of a runaway generation is storage, not
 * evidence. An `ok` answer is never cut: it is what a reuse replays, and a half answer that no
 * longer parses would silently turn a completed chapter back into a pending one.
 */
export const RESPONSE_CAP_CHARS = 200_000;

function storedResponse(write: RunWrite): string {
  if (write.status === 'ok' || write.response.length <= RESPONSE_CAP_CHARS) return write.response;
  const cut = write.response.slice(0, RESPONSE_CAP_CHARS);
  // A UTF-16 slice can end on half a surrogate pair; a lone surrogate is not text.
  return /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

/** The tuple as one string: what a question is, before it is hashed or counted. */
export function questionKey(question: Question): string {
  return (
    `${String(question.chapter)}|${String(question.rev)}|${question.textSha}|${question.promptSha}|` +
    `${question.model}|${question.pass}`
  );
}

/**
 * `run_<sha1(tuple|ordinal)[0..20]>`: the n-th run of one question. The ordinal is what keeps a
 * re-ask a different row under a different name — a row id derived from the question alone would
 * collide with the answer it is superseding.
 */
export function runIdOf(question: Question, ordinal = 1): string {
  return idOf('run', `${questionKey(question)}|${String(ordinal)}`);
}

/** `per` tokens of the pin's price: the input, its cached part, and the output. */
export function usdOf(pricing: Pipeline['pricing'], usage: ModelUsage): number {
  const per = pricing.per;
  const cached = Math.max(0, Math.min(usage.cached, usage.in));
  const fresh = usage.in - cached;
  const usd =
    (fresh / per) * pricing.input + (cached / per) * pricing.cacheRead + (usage.out / per) * pricing.output;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

const QUESTION_WHERE = `chapter = @chapter AND rev = @rev AND text_sha = @textSha
  AND prompt_sha = @promptSha AND model = @model AND pass = @pass`;

function paramsOf(question: Question): Record<string, string | number> {
  return {
    chapter: question.chapter,
    rev: question.rev,
    textSha: question.textSha,
    promptSha: question.promptSha,
    model: question.model,
    pass: question.pass,
  };
}

/**
 * The latest completed answer to a question, or `undefined` when the model has not been asked.
 * «Latest» is `at` then insertion order: two runs of one question in the same second still have a
 * definite last one, and the row the operator just wrote is the one a reuse should honour.
 */
export function latestOkRun(db: Db, question: Question): OkRun | undefined {
  const row = db
    .prepare(
      `SELECT id, model, prompt_sha AS promptSha, at, tokens_in AS tokensIn, tokens_out AS tokensOut,
              tokens_cached AS tokensCached, usd, facts, uses, edges, threads, rejects, response
         FROM extraction_runs
        WHERE ${QUESTION_WHERE} AND status = 'ok'
        ORDER BY at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(paramsOf(question)) as
    | {
        id: string;
        model: string;
        promptSha: string;
        at: string;
        tokensIn: number;
        tokensOut: number;
        tokensCached: number;
        usd: number;
        facts: number;
        uses: number;
        edges: number;
        threads: number;
        rejects: string;
        response: string;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    id: row.id,
    model: row.model,
    promptSha: row.promptSha,
    at: row.at,
    usd: row.usd,
    usage: { in: row.tokensIn, out: row.tokensOut, cached: row.tokensCached },
    facts: row.facts,
    uses: row.uses,
    edges: row.edges,
    threads: row.threads,
    rejects: rejectsOf(row.rejects),
    response: row.response,
  };
}

/** The ordinal a new run of this question takes: one past the runs already recorded for it. */
export function nextRunId(db: Db, question: Question): string {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM extraction_runs WHERE ${QUESTION_WHERE}`)
    .get(paramsOf(question)) as { n: number };
  return runIdOf(question, row.n + 1);
}

const INSERT_RUN = `
INSERT INTO extraction_runs
  (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status, request_sha, response,
   tokens_in, tokens_out, tokens_cached, usd, facts, uses, edges, threads, rejects, error)
VALUES
  (@id, @chapter, @rev, @textSha, @promptSha, @model, @pass, @at, @status, @requestSha, @response,
   @tokensIn, @tokensOut, @tokensCached, @usd, @facts, @uses, @edges, @threads, @rejects, @error)`;

/**
 * One statement, so it is atomic on its own: a caller that has just rolled a transaction back can
 * record the refusal without opening a second one. The returned id is the row's — a re-ask never
 * reuses the id of the answer it supersedes. After a rollback the ordinal is available again, so a
 * refused run takes the same name the rolled-back attempt would have had. The answer is stored
 * whole on `ok` and capped on a refusal (`storedResponse`), so a truncation leaves its text.
 */
export function recordRun(db: Db, question: Question, write: RunWrite): string {
  const id = nextRunId(db, question);
  db.prepare(INSERT_RUN).run({
    id,
    ...paramsOf(question),
    at: write.at,
    status: write.status,
    requestSha: write.requestSha,
    response: storedResponse(write),
    tokensIn: write.usage.in,
    tokensOut: write.usage.out,
    tokensCached: write.usage.cached,
    usd: write.usd,
    facts: write.counts.facts,
    uses: write.counts.uses,
    edges: write.counts.edges,
    threads: write.counts.threads,
    rejects: JSON.stringify(write.rejects),
    error: write.error,
  });
  return id;
}
