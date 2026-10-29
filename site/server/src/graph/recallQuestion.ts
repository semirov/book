/**
 * The recall question a stored answer names (BOOK-185, BOOK-DOC-77 §4).
 *
 * The recall prompt is built from the first pass's answer, so its sha is a function of that answer
 * and the chapter — never of a clock or of the graph. That is what makes a stored recall run
 * findable without a second pointer column: rebuild the prompt from the extract run's own text and
 * the question tuple is the one that was asked.
 *
 * Rebuilding revalidates the stored answer against the current lists. The validator is pure and
 * the lists a chapter sees are the ones established **before** it, so a chapter that was not
 * re-extracted sees the same lists; a change in an earlier chapter changes those lists and with
 * them the extract prompt's sha, which already stops a reuse upstream.
 */

import type { Db } from '../db/db.ts';
import { recallPromptOf } from './recall.ts';
import { latestOkRun, type OkRun, type Question } from './runs.ts';
import type { PreparedChapter } from './question.ts';
import { parseAnswer } from './schema.ts';
import { validateAnswer, type ValidateResult } from './validate.ts';

/**
 * A stored first answer, validated against the chapter as it stands today. Null when the row
 * cannot be read as an answer: a hand-edited response is not a question to rebuild.
 */
export function storedFirstAnswer(prepared: PreparedChapter, response: string): ValidateResult | null {
  const parsed = parseAnswer(response);
  if (!parsed.ok) return null;
  return validateAnswer({
    chapter: prepared.chapter,
    blocks: prepared.blocks,
    established: prepared.established,
    threads: prepared.threads,
    answer: parsed.answer,
  });
}

/** The recall question this chapter's stored first answer asked, or null if it cannot be read. */
export function recallQuestionOf(
  prepared: PreparedChapter,
  model: string,
  response: string,
): Question | null {
  const first = storedFirstAnswer(prepared, response);
  if (first === null) return null;
  const prompt = recallPromptOf(prepared.chapter, prepared.text, first);
  return {
    chapter: prepared.chapter,
    rev: prepared.rev,
    textSha: prepared.textSha,
    promptSha: prompt.sha,
    model,
    pass: 'recall',
  };
}

/** The stored recall run for this chapter, or null when the recall question was never answered. */
export function storedRecallRun(
  db: Db,
  prepared: PreparedChapter,
  extracted: OkRun,
  model: string,
): OkRun | null {
  const question = recallQuestionOf(prepared, model, extracted.response);
  if (question === null) return null;
  return latestOkRun(db, question) ?? null;
}

/**
 * Whether the chapter's question has been answered. With the recall on, a chapter whose first pass
 * landed but whose recall failed is still unresolved — the operator asked for both, and only a
 * completed pair is the answer. `--no-recall` asks for the cheap path and accepts the extract run.
 */
export function isAnswered(db: Db, prepared: PreparedChapter, model: string, noRecall = false): boolean {
  const done = latestOkRun(db, prepared.question);
  if (done === undefined) return false;
  if (noRecall) return true;
  return storedRecallRun(db, prepared, done, model) !== null;
}
