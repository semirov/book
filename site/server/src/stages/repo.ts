/**
 * The stage store (docs/writer-lane.md §2–§3): the one place `pass_stages` is written, and
 * the replay the reader's stage stream is built from.
 *
 * Every write goes through `normalizeStageEvent`, so the summary/span bounds and the stage
 * vocabulary are enforced at the table's edge, not only at the HTTP door. `stage_seq` may be
 * omitted (the site emits `typing` and holds no counter): the store then assigns
 * `max(stage_seq) + 1` for that pass, while `UNIQUE (pass_id, stage_seq)` makes a retried
 * call return the stored row instead of a duplicate.
 */

import {
  normalizeStageEvent,
  type PassStage,
  type PassStageEvent,
  type StageSpan,
  type StageSpanInput,
} from '@book/shared';

import type { Db } from '../db/db.ts';

type StageRow = {
  seq: number;
  pass_id: string;
  chapter: number;
  stage_seq: number;
  stage: string;
  at: string;
  actor_process: string;
  actor_model: string | null;
  change_id: string | null;
  summary: string;
  span: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
};

export type StageAppendInput = {
  chapter: number;
  passId: string;
  stageSeq?: number | null;
  stage: string;
  at: number;
  actor: { process: string; model?: string | null };
  changeId?: string | null;
  summary: string;
  span?: readonly StageSpanInput[] | null;
  tokens?: { in: number; out: number } | null;
  costUsd?: number | null;
};

/** The store refused the input; the HTTP door turns the code into a 422, never a 500. */
export class StageInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StageInputError';
    this.code = code;
  }
}

export type ResolvedPass = { chapter: number; changeId: string | null };

/**
 * The pass's chapter and the change it carries, read from the engine's own rows. A draft pass
 * has no change; a change pass gets it from its lease, or from the revision it already wrote.
 * The body of `POST /internal/stage` never supplies either fact.
 */
export function resolvePass(db: Db, passId: string): ResolvedPass | null {
  const row = db
    .prepare(
      `SELECT s.chapter AS chapter,
              COALESCE(
                (SELECT l.change_id FROM leases l
                  WHERE l.step_id = s.step_id AND l.change_id IS NOT NULL
                  ORDER BY l.acquired_at DESC LIMIT 1),
                (SELECT r.change_id FROM revisions r
                  WHERE r.step_id = s.step_id AND r.change_id IS NOT NULL
                  ORDER BY r.rev DESC LIMIT 1)
              ) AS change_id
         FROM steps s WHERE s.step_id = ?`,
    )
    .get(passId) as { chapter: number | null; change_id: string | null } | undefined;
  if (row === undefined || row.chapter === null) return null;
  return { chapter: row.chapter, changeId: row.change_id };
}

/** The store's own order; the tailer's replay cursor starts here at boot. */
export function maxStageSeq(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM pass_stages').get() as { seq: number };
  return row.seq;
}

/** `max(stage_seq) + 1` for one pass (0 → 1). Not the chapter's counter. */
export function nextStageSeq(db: Db, passId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(stage_seq), 0) + 1 AS seq FROM pass_stages WHERE pass_id = ?')
    .get(passId) as { seq: number };
  return row.seq;
}

const INSERT_SQL = `INSERT INTO pass_stages
  (pass_id, chapter, stage_seq, stage, at, actor_process, actor_model, change_id, summary, span,
   tokens_in, tokens_out, cost_usd)
  VALUES (@passId, @chapter, @stageSeq, @stage, @at, @actorProcess, @actorModel, @changeId, @summary,
          @span, @tokensIn, @tokensOut, @costUsd)
  ON CONFLICT (pass_id, stage_seq) DO NOTHING`;

/**
 * Append one stage. A repeat of `(passId, stageSeq)` returns the row already stored — the
 * same event as the first call, so a retried lane request cannot duplicate a stage.
 */
export function appendStage(db: Db, input: StageAppendInput): PassStageEvent {
  if (!Number.isInteger(input.chapter) || input.chapter < 1 || input.chapter > 67) {
    throw new StageInputError('INVALID_CHAPTER', 'chapter must be 1..67');
  }
  const normalized = normalizeStageEvent(input);
  if (!normalized.ok) throw new StageInputError(normalized.code, normalized.reason);
  const value = normalized.value;

  const row = {
    passId: value.passId,
    chapter: input.chapter,
    stage: value.stage,
    // ISO-8601 UTC keeps the millisecond the work happened at, so a replay carries `at` as
    // it was observed and not a rounded second.
    at: new Date(value.at).toISOString(),
    actorProcess: value.actor.process,
    actorModel: value.actor.model,
    changeId: value.changeId,
    summary: value.summary,
    span: value.span === null ? null : JSON.stringify(value.span),
    tokensIn: value.tokens === null ? null : value.tokens.in,
    tokensOut: value.tokens === null ? null : value.tokens.out,
    costUsd: value.costUsd,
  };

  if (value.stageSeq === null) {
    // The site holds no counter: assign the pass's next number and let the unique index settle
    // a collision (a retry of another writer's append) by taking the next one.
    const assigned = db.transaction((): number => {
      const insert = db.prepare(INSERT_SQL);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const stageSeq = nextStageSeq(db, value.passId);
        const result = insert.run({ ...row, stageSeq });
        if (result.changes === 1) return stageSeq;
      }
      throw new StageInputError('STAGE_SEQ_BUSY', 'could not assign a stage_seq for this pass');
    })();
    return toEvent(readRow(db, value.passId, assigned));
  }

  db.prepare(INSERT_SQL).run({ ...row, stageSeq: value.stageSeq });
  return toEvent(readRow(db, value.passId, value.stageSeq));
}

/** One row by its pass-local number, or a refusal if the table lost it (it cannot). */
function readRow(db: Db, passId: string, stageSeq: number): StageRow {
  const row = db
    .prepare('SELECT * FROM pass_stages WHERE pass_id = ? AND stage_seq = ?')
    .get(passId, stageSeq) as StageRow | undefined;
  if (row === undefined) throw new StageInputError('STAGE_NOT_STORED', 'the stage row disappeared after the write');
  return row;
}

/**
 * The chapter's stages, newest pass first and `stage_seq` order inside a pass — the shape a
 * reconnecting reader reads. `pass` narrows the list to one pass.
 */
export function listStages(
  db: Db,
  chapter: number,
  options: { limit: number; pass?: string | null } = { limit: 50 },
): PassStageEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM pass_stages
        WHERE chapter = @chapter AND (@pass IS NULL OR pass_id = @pass)
        ORDER BY (SELECT MAX(seq) FROM pass_stages newer WHERE newer.pass_id = pass_stages.pass_id) DESC,
                 stage_seq ASC
        LIMIT @limit`,
    )
    .all({ chapter, pass: options.pass ?? null, limit: options.limit }) as StageRow[];
  return rows.map(toEvent);
}

/** Rows past the tailer's cursor, in `seq` order — the live fan-out's source. */
export function listStageRowsAfter(db: Db, cursor: number, limit: number): Array<{ seq: number; event: PassStageEvent }> {
  const rows = db
    .prepare('SELECT * FROM pass_stages WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(cursor, limit) as StageRow[];
  return rows.map((row) => ({ seq: row.seq, event: toEvent(row) }));
}

function toEvent(row: StageRow): PassStageEvent {
  const span = row.span === null ? null : (JSON.parse(row.span) as StageSpan[]);
  const tokens =
    row.tokens_in === null && row.tokens_out === null ? null : { in: row.tokens_in ?? 0, out: row.tokens_out ?? 0 };
  return {
    passId: row.pass_id,
    chapter: row.chapter,
    stageSeq: row.stage_seq,
    stage: row.stage as PassStage,
    at: Date.parse(row.at),
    actor: { process: row.actor_process as PassStageEvent['actor']['process'], model: row.actor_model },
    changeId: row.change_id,
    summary: row.summary,
    span,
    tokens,
    costUsd: row.cost_usd,
  };
}
