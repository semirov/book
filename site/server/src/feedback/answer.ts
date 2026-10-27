/**
 * `--answer <json | @file | ->` (BOOK-61 review B2, an amendment to BOOK-DOC-42 §5's CLI line).
 *
 * The design's whole point is that a gate's answer is data bound to an envelope: the verdict
 * names an `itemId` of the batch, quotes a field that really holds the words it says, and a
 * quote that is not there drops the answer. Before this module the parser was reached by tests
 * only — the CLI took `--verdict FITS` and recorded an opinion with no evidence at all.
 *
 * So the CLI grows a second path beside the operator's: the model's own `book.verdict/v1`
 * object, read from an argument, a file or stdin, parsed against the batch the comment belongs
 * to, post-checked, and only then recorded. The operator path stays as it was — a human
 * decision carries no model evidence, and the two cannot be combined for one call.
 *
 * This module is pure apart from reading the batch file: no model, no network.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { Db } from '../db/db.ts';
import { parseVerdict, type AcceptedVerdict, type GateId } from './gate.ts';
import { readBatchLines } from './batches.ts';
import type { FilingEnvelope } from './envelope.ts';

export type ReadAnswerInput = {
  db: Db;
  /** The feedback exchange directory the batch files live in. */
  dir: string;
  commentId: string;
  /** Which gate's answer this is: `C` for `audit`, `B` for `rights`. */
  gate: GateId;
  /** The raw flag value: inline JSON, `@file`, or `-` for stdin. */
  raw: string;
};

export type ReadAnswer =
  | { ok: true; verdict: AcceptedVerdict }
  | { ok: false; code: AnswerFailureCode; message: string };

export type AnswerFailureCode =
  | 'ANSWER_UNREADABLE'
  | 'ANSWER_NOT_JSON'
  | 'NO_BATCH'
  | 'VERDICT_MALFORMED'
  | 'POSTCHECK_FAILED';

/** The answer text as the operator wrote it: inline, from a file (`@path`), or from stdin. */
function answerText(raw: string): { ok: true; text: string } | { ok: false; message: string } {
  const value = raw.trim();
  if (value === '-') {
    try {
      return { ok: true, text: readFileSync(0, 'utf8') };
    } catch (error) {
      return { ok: false, message: `cannot read stdin: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (value.startsWith('@')) {
    const path = value.slice(1).trim();
    try {
      return { ok: true, text: readFileSync(isAbsolute(path) ? path : resolve(path), 'utf8') };
    } catch {
      return { ok: false, message: `cannot read ${path}` };
    }
  }
  return { ok: true, text: value };
}

/**
 * Read one recorded answer and check it against the batch it answers. Everything the parser
 * says is returned as a code the CLI prints: nothing is recorded by this module, so a refused
 * answer leaves the row exactly as it was.
 */
export function readAnswer(input: ReadAnswerInput): ReadAnswer {
  const text = answerText(input.raw);
  if (!text.ok) return { ok: false, code: 'ANSWER_UNREADABLE', message: text.message };

  let raw: unknown;
  try {
    raw = JSON.parse(text.text) as unknown;
  } catch {
    return { ok: false, code: 'ANSWER_NOT_JSON', message: '--answer is not one JSON object' };
  }

  // The envelope is the batch the filing was written into: a verdict without one is an opinion
  // about a row no model read, and the parser must never be handed an empty "batch".
  const row = input.db.prepare('SELECT batch_id FROM comments WHERE id = ?').get(input.commentId) as
    | { batch_id: string | null }
    | undefined;
  if (row === undefined) return { ok: false, code: 'NO_BATCH', message: `unknown comment: ${input.commentId}` };
  if (row.batch_id === null || row.batch_id.length === 0) {
    return {
      ok: false,
      code: 'NO_BATCH',
      message: `${input.commentId} is not in a batch — an answer must name an envelope of one`,
    };
  }
  let items: Map<string, FilingEnvelope>;
  try {
    items = new Map(readBatchLines(input.dir, row.batch_id).map((envelope) => [envelope.itemId, envelope]));
  } catch (error) {
    return {
      ok: false,
      code: 'NO_BATCH',
      message: `batch ${row.batch_id} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseVerdict(raw, { gate: input.gate, items });
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.detail };
  return { ok: true, verdict: parsed.verdict };
}
