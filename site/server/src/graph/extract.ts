/**
 * One chapter, read by the model and checked by code (BOOK-185, BOOK-DOC-77 §2, §4, §5).
 *
 * The orchestrator of the extraction pass, and nothing else: it retrieves the two lists the
 * prompt needs, asks the provider, parses, validates, persists and records the run. Every rule
 * lives elsewhere (`prompt.ts`, `schema.ts`, `validate.ts`, `persist.ts`, `recall.ts`); this file
 * only decides **when** each of them is asked and what a failure leaves behind.
 *
 * **Two questions, one answer.** The first pass registers what the chapter says. A second,
 * adversarial call (`buildRecallPrompt`) reads the same chapter against the first list and returns
 * only what it missed; code merges the additions (`recall.ts`) and writes one answer. The recall is
 * **additive**: a schema failure or a transport error there is recorded as its own run and the
 * first pass lands anyway. `noRecall` is the operator's switch for the cheap path.
 *
 * **Reuse before a call.** A completed run for the same question — the same chapter, revision,
 * text sha, prompt sha and model — is the answer: the rows are already in the graph, and asking
 * again would pay twice for a question the book has answered. With the recall on, the chapter is
 * answered only when **both** runs exist: the recall prompt is built from the first answer, so a
 * stored extract run names the second question exactly (`recallQuestionOf`). `force` is the
 * operator's override and re-asks both.
 *
 * **A repair is one more question, not a guess.** A schema failure re-asks once with the same
 * system message and the same chapter, plus one line: return only valid JSON in the given shape.
 * A second failure is `SCHEMA_INVALID` — no rows, the run recorded refused, the raw answer kept.
 * **A cut answer is not a bad one:** `finish_reason: length` is `MODEL_TRUNCATED` with no repair
 * (`pass.ts` decides), because the cap that cut the answer would cut the retry the same way.
 *
 * **An empty answer to a written chapter is a refusal.** A chapter with prose that yields no fact,
 * no use and no edge would retire the whole graph the chapter already had, so it is refused with
 * `EMPTY_EXTRACTION` and the old rows stay — and it is the **merged** answer that is judged, so a
 * recall that found something is not refused for the first pass's silence. A basis or empty
 * chapter (under `MIN_PROSE_CHARS`) may legitimately be empty; the threshold is the only place
 * that difference is decided.
 *
 * **What a failure leaves.** The rows and the runs' own `ok` records are written in one
 * transaction, so a refusal (`FACT_NOT_ESTABLISHED`, `FRAME_CHANGED`) rolls all of them back; the
 * extract run is then recorded refused in a second, separate statement. A transport failure is a
 * run with `status = 'error'` and the model's error code — never the response body, never the key.
 *
 * `dryRun` answers «what would this write?» and writes nothing at all: no run row, so the
 * question stays unanswered and a later real call is not mistaken for a replay.
 */

import type { Db } from '../db/db.ts';
import { cpLength } from '../ledger/spans.ts';
import { apiModelOf, type Pipeline } from '../pipeline.ts';
import { sha256Hex } from '../util/hash.ts';
import { toIso } from '../util/time.ts';
import { FactNotEstablishedError } from './integrity.ts';
import { totalMetaOf, type ExtractOutcome, type FirstPass, type Passes, type RecallInfo } from './outcome.ts';
import { askPass, type Provider } from './pass.ts';
import {
  FrameChangedError,
  persistExtraction,
  type ExtractionStamp,
  type PersistResult,
} from './persist.ts';
import { FactChapterAheadError } from './persistFacts.ts';
import { prepareChapter } from './question.ts';
import type { RecallPrompt } from './prompt.ts';
import { firstKeysOf, mergeRecall, NOTHING_ADDED, recallLocals, recallPromptOf, resolveRecallUses } from './recall.ts';
import { storedFirstAnswer, storedRecallRun } from './recallQuestion.ts';
import { latestOkRun, recordRun, usdOf, type Question, type RunCounts, type RunWrite } from './runs.ts';
import { validateAnswer, type ValidateResult } from './validate.ts';

// The question and its retrieved lists live in `question.ts` (the CLI asks the same one); this
// module keeps the re-export so the pass's own callers do not need a second import path.
export { prepareChapter, threadHintsOf } from './question.ts';
export type { PreparedChapter } from './question.ts';
// The model seam and the outcome types moved out at the 500-line limit; the re-exports keep
// `extract.ts` the one import path its callers already use.
export { askPass, MODEL_TRUNCATED, REPAIR_LINE, type Provider, type ProviderAnswer, type ProviderRequest } from './pass.ts';
export type {
  ExtractDry,
  ExtractOutcome,
  ExtractRefused,
  ExtractReused,
  ExtractWritten,
  Passes,
  PassInfo,
  RecallInfo,
  RunMeta,
} from './outcome.ts';
// The recall question — «has this chapter been answered?» — is the CLI's `--pending` too.
export { isAnswered } from './recallQuestion.ts';

/** `EMPTY_EXTRACTION`: a written chapter answered with nothing would retire its whole graph. */
export const EMPTY_EXTRACTION = 'EMPTY_EXTRACTION';

/** Below this many prose characters a chapter may legitimately yield nothing (basis, front matter). */
export const MIN_PROSE_CHARS = 1000;

const ZERO: RunCounts = { facts: 0, uses: 0, edges: 0, threads: 0 };

const SKIPPED: RecallInfo = { skipped: true };

export type ExtractOptions = {
  db: Db;
  chapter: number;
  provider: Provider;
  /** The pin: the wire model and the rates a run is charged at. */
  pipeline: Pipeline;
  at?: string;
  /** Ask again even when a completed run answers this question. */
  force?: boolean;
  /** Validate and report, write nothing. */
  dryRun?: boolean;
  /** Skip the adversarial recall pass: the first answer is the answer. */
  noRecall?: boolean;
  /**
   * `max_tokens` for **both** passes' requests (`graph extract --max-output`), overriding the pin
   * for this run: a recall cut at the pin is the same lost chapter as a cut extract.
   */
  maxOutputTokens?: number;
};

// ---------------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------------

/** Extract one chapter. Throws only when the chapter is not in the book at all. */
export async function extractChapter(options: ExtractOptions): Promise<ExtractOutcome> {
  const db = options.db;
  const chapter = options.chapter;
  const at = options.at ?? toIso(Date.now());
  const model = apiModelOf(options.pipeline);
  const prepared = prepareChapter(db, chapter, model);
  const { blocks, text, established, threads, prompt, system, user, question } = prepared;
  const requestSha = sha256Hex(user);
  const recallEnabled = options.noRecall !== true;
  /**
   * The stored first answer when the recall question is the only one left. A completed extract run
   * *is* the answer to the first question, so asking it again pays twice for a question the book
   * has already answered (BOOK-185 defect 7).
   */
  let stored: FirstPass | null = null;

  if (options.dryRun !== true && options.force !== true) {
    const done = latestOkRun(db, question);
    if (done !== undefined) {
      const recall = recallEnabled ? storedRecallRun(db, prepared, done, model) : null;
      if (!recallEnabled || recall !== null) {
        const passes: Passes = {
          extract: { run: done.id, usage: done.usage, usd: done.usd, rejects: done.rejects },
          recall:
            recall === null
              ? SKIPPED
              : {
                  skipped: false,
                  run: recall.id,
                  ok: true,
                  code: null,
                  usage: recall.usage,
                  usd: recall.usd,
                  rejects: recall.rejects,
                  added: { facts: recall.facts, edges: recall.edges, threads: recall.threads },
                },
        };
        return {
          ok: true,
          reused: true,
          chapter,
          rev: prepared.rev,
          run: done.id,
          counts: { facts: done.facts, uses: done.uses, edges: done.edges, threads: done.threads },
          rejects: done.rejects,
          passes,
          ...totalMetaOf(done.model, done.promptSha, passes),
        };
      }
      // The recall question was never answered: revalidate the stored answer and ask only it.
      const first = storedFirstAnswer(prepared, done.response);
      if (first !== null) stored = { kind: 'stored', run: done, first };
    }
  }

  /** The first answer's provenance: the stored run, or the call this run paid for. */
  let pass: FirstPass;
  if (stored !== null) {
    pass = stored;
  } else {
    const answered = await askPass({
      provider: options.provider,
      system,
      user,
      maxTokens: options.maxOutputTokens ?? options.pipeline.maxOutputTokens,
    });

    if (!answered.ok) {
      const run = recordRun(db, question, {
        status: answered.transport ? 'error' : 'refused',
        at,
        requestSha,
        response: answered.response,
        usage: answered.usage,
        usd: usdOf(options.pipeline.pricing, answered.usage),
        counts: ZERO,
        rejects: [],
        error: answered.code,
      });
      const passes: Passes = {
        extract: { run, usage: answered.usage, usd: usdOf(options.pipeline.pricing, answered.usage), rejects: [] },
        recall: SKIPPED,
      };
      return {
        ok: false,
        reused: false,
        chapter,
        rev: prepared.rev,
        run,
        code: answered.code,
        rejects: [],
        passes,
        ...totalMetaOf(model, prompt.sha, passes),
      };
    }

    pass = {
      kind: 'asked',
      answered,
      first: validateAnswer({ chapter, blocks, established, threads, answer: answered.answer }),
    };
  }

  const first = pass.first;
  const firstCounts: RunCounts = {
    facts: first.facts.length,
    uses: first.uses.length,
    edges: first.edges.length,
    threads: first.threads.length,
  };
  /**
   * The extract run as the outcome and the stamps read it. A stored answer keeps its own run row
   * (`recordExtract` is false): the row is already in the ledger and recording a second one would
   * tell the audit that this attempt asked a question it did not ask.
   */
  const extractWrite: RunWrite = {
    status: 'ok',
    at: pass.kind === 'stored' ? pass.run.at : at,
    requestSha,
    response: pass.kind === 'stored' ? pass.run.response : pass.answered.response,
    usage: pass.kind === 'stored' ? pass.run.usage : pass.answered.usage,
    usd: pass.kind === 'stored' ? pass.run.usd : usdOf(options.pipeline.pricing, pass.answered.usage),
    counts: firstCounts,
    rejects: first.rejects,
    error: null,
  };
  const recordExtract = pass.kind === 'asked';

  let merged: ValidateResult = first;
  let recall: RecallInfo = SKIPPED;
  /** The second run's row, written with the answer in one transaction (null when skipped). */
  let recallWrite: { question: Question; write: RunWrite } | null = null;

  if (recallEnabled) {
    const recallPrompt: RecallPrompt = recallPromptOf(chapter, text, first);
    const recallQuestion: Question = {
      chapter,
      rev: prepared.rev,
      textSha: prepared.textSha,
      promptSha: recallPrompt.sha,
      model,
      pass: 'recall',
    };
    const recallUser = recallPrompt.messages[1]?.content ?? '';
    const recallAsked = await askPass({
      provider: options.provider,
      system: recallPrompt.messages[0]?.content ?? '',
      user: recallUser,
      maxTokens: options.maxOutputTokens ?? options.pipeline.maxOutputTokens,
    });
    const recallUsd = usdOf(options.pipeline.pricing, recallAsked.usage);

    if (recallAsked.ok) {
      const locals = recallLocals(chapter, first);
      const validated = validateAnswer({
        chapter,
        blocks,
        established: [...established, ...locals.established],
        threads: [...threads, ...locals.threads],
        answer: resolveRecallUses(recallAsked.answer, firstKeysOf(first)),
      });
      const mergedAnswer = mergeRecall({ chapter, first, recall: validated });
      merged = mergedAnswer.answer;
      const uses = validated.uses.filter((use) => use.role === 'use').length;
      recall = {
        skipped: false,
        run: null,
        ok: true,
        code: null,
        usage: recallAsked.usage,
        usd: recallUsd,
        rejects: validated.rejects,
        added: mergedAnswer.added,
      };
      recallWrite = {
        question: recallQuestion,
        write: {
          status: 'ok',
          at,
          requestSha: sha256Hex(recallUser),
          response: recallAsked.response,
          usage: recallAsked.usage,
          usd: recallUsd,
          // The recall row's counts are what it **added** — «what did recall buy» is the number
          // the report reads back, and a forced re-ask does not double it.
          counts: { facts: mergedAnswer.added.facts, uses, edges: mergedAnswer.added.edges, threads: mergedAnswer.added.threads },
          rejects: validated.rejects,
          error: null,
        },
      };
    } else {
      // The recall is additive: a failed second opinion does not lose the first one.
      recall = {
        skipped: false,
        run: null,
        ok: false,
        code: recallAsked.code,
        usage: recallAsked.usage,
        usd: recallUsd,
        rejects: [],
        added: NOTHING_ADDED,
      };
      recallWrite = {
        question: recallQuestion,
        write: {
          status: recallAsked.transport ? 'error' : 'refused',
          at,
          requestSha: sha256Hex(recallUser),
          response: recallAsked.response,
          usage: recallAsked.usage,
          usd: recallUsd,
          counts: ZERO,
          rejects: [],
          error: recallAsked.code,
        },
      };
    }
  }

  /**
   * A written chapter answered with nothing would retire every row the chapter already had: the
   * persist step treats «the answer no longer states it» as supersession. So the merged answer is
   * refused whole, with the response and the rejects kept for whoever reads the run.
   */
  const empty =
    cpLength(text) > MIN_PROSE_CHARS && merged.facts.length + merged.uses.length + merged.edges.length === 0;
  if (empty) {
    extractWrite.status = 'refused';
    extractWrite.counts = ZERO;
    extractWrite.error = EMPTY_EXTRACTION;
    // The recall call itself succeeded, but nothing it answered was persisted: a run row that says
    // `ok` about an answer the graph never took is a lie the audit cannot see (defect 8).
    if (recallWrite !== null) {
      recallWrite.write.status = 'refused';
      recallWrite.write.counts = ZERO;
      recallWrite.write.error = EMPTY_EXTRACTION;
    }
    if (!recall.skipped) recall = { ...recall, added: NOTHING_ADDED };
  }

  /** The two passes as the outcome reads them; the run ids are filled in once they are recorded. */
  const atRest: Passes = {
    extract: {
      run: pass.kind === 'stored' ? pass.run.id : null,
      usage: extractWrite.usage,
      usd: extractWrite.usd,
      rejects: first.rejects,
    },
    recall,
  };

  if (options.dryRun === true) {
    // A dry run answers «what would this write?» — and an empty answer to a written chapter would
    // write nothing over rows that exist, so it is the same refusal, without a run row.
    if (empty) {
      return {
        ok: false,
        reused: false,
        chapter,
        rev: prepared.rev,
        run: null,
        code: EMPTY_EXTRACTION,
        rejects: merged.rejects,
        passes: atRest,
        ...totalMetaOf(model, prompt.sha, atRest),
      };
    }
    return {
      ok: true,
      reused: false,
      dryRun: true,
      chapter,
      rev: prepared.rev,
      run: null,
      accepted: { facts: merged.facts, uses: merged.uses, edges: merged.edges, threads: merged.threads },
      rejects: merged.rejects,
      duplicates: merged.duplicates,
      passes: atRest,
      ...totalMetaOf(model, prompt.sha, atRest),
    };
  }

  try {
    // The run rows go first: `superseded_by_extraction` and `retired_by_run` reference the
    // extract run, and the transaction is what makes «the runs and the rows» one act.
    const result = db.transaction((): { extractRun: string; recallRun: string | null; written: PersistResult | null } => {
      const extractRun = pass.kind === 'stored' ? pass.run.id : recordRun(db, question, extractWrite);
      const recallRun = recallWrite === null ? null : recordRun(db, recallWrite.question, recallWrite.write);
      if (empty) return { extractRun, recallRun, written: null };
      const extractStamp: ExtractionStamp =
        pass.kind === 'stored'
          ? { id: pass.run.id, model: pass.run.model, promptSha: pass.run.promptSha, at: pass.run.at, pass: 'extract' }
          : { id: extractRun, model, promptSha: prompt.sha, at, pass: 'extract' };
      const recallStamp: ExtractionStamp | undefined =
        recallRun === null || recallWrite === null
          ? undefined
          : { id: recallRun, model, promptSha: recallWrite.question.promptSha, at, pass: 'recall' };
      const rows = persistExtraction(db, {
        chapter,
        rev: prepared.rev,
        textSha: prepared.textSha,
        run: extractStamp,
        ...(recallStamp === undefined ? {} : { recallRun: recallStamp }),
        blocks,
        answer: merged,
      });
      return { extractRun, recallRun, written: rows };
    })();

    const passes: Passes = {
      extract: { ...atRest.extract, run: result.extractRun },
      recall: atRest.recall.skipped ? atRest.recall : { ...atRest.recall, run: result.recallRun },
    };

    if (result.written === null) {
      return {
        ok: false,
        reused: false,
        chapter,
        rev: prepared.rev,
        run: result.extractRun,
        code: EMPTY_EXTRACTION,
        rejects: merged.rejects,
        passes,
        ...totalMetaOf(model, prompt.sha, passes),
      };
    }

    return {
      ok: true,
      reused: false,
      dryRun: false,
      chapter,
      rev: prepared.rev,
      run: result.extractRun,
      counts: result.written,
      rejects: merged.rejects,
      duplicates: merged.duplicates,
      passes,
      ...totalMetaOf(model, prompt.sha, passes),
    };
  } catch (error) {
    // The rollback took the rows and the `ok` rows with it; the refusal is recorded on its own.
    const refused =
      error instanceof FactNotEstablishedError ||
      error instanceof FactChapterAheadError ||
      error instanceof FrameChangedError;
    const code =
      error instanceof FactNotEstablishedError || error instanceof FactChapterAheadError
        ? 'FACT_NOT_ESTABLISHED'
        : error instanceof FrameChangedError
          ? 'FRAME_CHANGED'
          : 'EXTRACT_ERROR';
    const run =
      recordExtract
        ? db.transaction((): string =>
            recordRun(db, question, { ...extractWrite, status: refused ? 'refused' : 'error', error: code }),
          )()
        : null;
    // The recall row rolled back with the rows it described: nothing it added is in the graph, so
    // the outcome cannot claim an addition that no longer exists.
    const passes: Passes = {
      extract: { ...atRest.extract, run: run ?? atRest.extract.run },
      recall: atRest.recall.skipped ? atRest.recall : { ...atRest.recall, run: null, added: NOTHING_ADDED },
    };
    return {
      ok: false,
      reused: false,
      chapter,
      rev: prepared.rev,
      run,
      code,
      rejects: merged.rejects,
      passes,
      ...totalMetaOf(model, prompt.sha, passes),
    };
  }
}
