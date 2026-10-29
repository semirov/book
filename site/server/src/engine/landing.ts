/**
 * The landing's own half of `engine/write.ts` (BOOK-173 §2/§7, BOOK-187): what a step's text
 * becomes when it is published, and what a repeated call re-lands.
 *
 * It lives apart from `write.ts` because that file is the door's rules and was at the file-size
 * wall; the ingest itself is untouched — this module only decides *which* text goes in and
 * carries the frozen plan out of the ingest's transaction.
 */

import { applyChapterFile, type ApplyChapterResult } from '../ingest/applyChapter.ts';
import { applyFrontFile, type ApplyFrontResult } from '../ingest/applyFront.ts';
import { normalizeChapterText, parseChapter } from '../ingest/parseChapter.ts';
import { parseFront } from '../ingest/parseFront.ts';
import type { SentencePatchEdit } from '../sentences/transform.ts';
import { toIso } from '../util/time.ts';
import { frameIntact } from '../ingest/frameGuard.ts';
import { appendEvent } from '../history/log.ts';
import { currentRev } from './close.ts';
import { measureDelta } from './helpers.ts';
import { scanStepDelta } from './rightsScan.ts';
import { settleLanding, type LandingPlan } from './ripple.ts';
import {
  chapterBodyOf,
  readChapterRows,
  readFrontRows,
  type ChapterText,
  type ChapterTextView,
  type FrontText,
} from './text.ts';
import * as store from './store.ts';
import { refuse, type EngineDeps } from './types.ts';

/** What a landing states about itself beyond its lease (BOOK-173 §2/§4). */
export type LandingOptions = {
  /** The patch, one character edit per block — what keeps sentence ids across the write. */
  sentences?: ReadonlyArray<SentencePatchEdit>;
  /** The mode the pass ran, recorded with the plan (or, with no plan, on the close). */
  mode?: 'patch' | 'rewrite';
  /** The pass's estimate, frozen with the plan and replaced by the actual at close. */
  estimateUsd?: number;
};

/** What the ingest published for a landing — and whether it refused the frame outright. */
export type IngestOutcome = {
  rev: number | null;
  changed: boolean;
  frameRejected: boolean;
  /**
   * BOOK-173: the plan frozen **inside** the ingest's transaction, if this landing earned one.
   * Carried out of the transaction so `land` can answer with it without writing anything else.
   */
  planned: LandingPlan | null;
};

/**
 * §6F.1: a landing is a revision, and a revision exists in the same transaction as its log
 * entry. `land` therefore publishes the text it validated through the same applier the
 * one-shot import uses — one choke point, so a writer's landing and an observed write cannot
 * disagree. The ingest is idempotent by sha: a second landing of the same text returns
 * `unchanged` and publishes nothing.
 */
export function ingestLanding(
  deps: EngineDeps,
  step: store.StepRow,
  at: number,
  raw: string,
  options: LandingOptions,
): IngestOutcome {
  const dataDir = deps.config.dataDir;
  if (step.pass === 'front') {
    const result: ApplyFrontResult = applyFrontFile({
      db: deps.db,
      dataDir,
      raw,
      mtimeMs: at,
      nowMs: at,
    });
    return { rev: result.rev, changed: result.status !== 'unchanged', frameRejected: false, planned: null };
  }
  if (step.chapter === null) return { rev: null, changed: false, frameRejected: false, planned: null };
  const n = step.chapter;
  // BOOK-173 review, fix 3: the plan is not a follow-up write. `onPublished` runs inside the
  // ingest's own transaction (`applyChapterFile`'s `db.transaction`), after the revision, its log
  // entry and the new `blocks` rows exist — so the plan commits with the landing or neither does.
  // The mention re-bind, the retirement of overrun claims and the plan itself are `settleLanding`
  // (`engine/ripple.ts`); the same call runs them again, in a transaction of its own, when the
  // site's watcher published these bytes first.
  let planned: LandingPlan | null = null;
  const result: ApplyChapterResult = applyChapterFile({
    db: deps.db,
    dataDir,
    n,
    raw,
    mtimeMs: at,
    nowMs: at,
    ...(options.sentences === undefined ? {} : { sentences: options.sentences }),
    onPublished: ({ rev }) => {
      planned = settleLanding(deps, step, rev, { mode: options.mode, priceUsd: options.estimateUsd });
    },
  });
  // BOOK-173 review round 3, fix 1: `onPublished` runs only when **this** call publishes. If the
  // watcher (same process, `ingest/watcher.ts`) or a concurrent land already published the same
  // bytes, the ingest answers `unchanged` and the ledger was never settled — the change then
  // closed `applied` with no plan and the ripple was silently skipped. `storePlan` is idempotent
  // per change, so this second door writes no second plan; it only closes the hole.
  if (result.status === 'unchanged' && (step.pass === 'change' || step.pass === 'cascade')) {
    const current = currentRev(deps.db, n);
    planned = deps.db.transaction(() =>
      settleLanding(deps, step, current, { mode: options.mode, priceUsd: options.estimateUsd }),
    )();
  }
  // BOOK-137: the second read is weaker than the guard's. Nothing was published, and the caller
  // must answer `FRAME_CHANGED` rather than invent a revision for text the site never served.
  if (result.status === 'frame-rejected') return { rev: null, changed: false, frameRejected: true, planned: null };
  if (result.status === 'created' || result.status === 'revised') {
    return { rev: result.rev, changed: true, frameRejected: false, planned };
  }
  // `unchanged`: the site already published these bytes — the revision exists, and the ledger was
  // settled by the fallback above, so the plan is still this landing's answer.
  if (result.status === 'unchanged') return { rev: null, changed: false, frameRejected: false, planned };
  // `empty`/`emptied`: an empty write between two saves publishes no revision either.
  return { rev: null, changed: false, frameRejected: false, planned: null };
}

/**
 * The target of a landing. With a text in the request it is that text, parsed exactly as the
 * applier will parse it; without one it is the rows, so a repeated call re-lands what the site
 * already serves. `exists: false` only when neither holds anything.
 */
export function chapterTarget(db: EngineDeps['db'], n: number, supplied: string | undefined): ChapterText {
  if (supplied === undefined) return readChapterRows(db, n);
  const raw = normalizeChapterText(supplied);
  // A supplied (even empty) text is a target: an empty one fails `isWrittenChapter` as
  // `NOT_WRITTEN`, which is the answer an empty file gave before BOOK-187.
  return { ...parseChapter(n, raw), exists: true, raw };
}

export function frontTarget(db: EngineDeps['db'], supplied: string | undefined): FrontText {
  if (supplied === undefined) return readFrontRows(db);
  const raw = normalizeChapterText(supplied);
  return { ...parseFront(raw), exists: true, raw };
}

/** BOOK-137 — the frame's refusal, spoken by both doors: the guard and the ingest. */
export const FRAME_CHANGED_MESSAGE = 'рамка книги: фраза этой главы не меняется — правка остаётся бумагой';

export type PublishResult = { rev: number; sha: string; changed: boolean };

/**
 * BOOK-222 — publish the step's candidate, once, at the close.
 *
 * The text is the one the gates read (`candidate_text`): it is re-parsed, its frame is checked
 * again, its own delta is scanned if no scan is on the step, and it goes through `ingestLanding`
 * — the same applier `land` uses. `landed_*`, the revision and the `step.landed` event are written
 * here, and only here: a step that closes without publishing (`refuse`) keeps none of them and the
 * chapter keeps the text the reader already has.
 *
 * `null` means the step carries no candidate (a non-provisional landing, a `noWrite` close): the
 * caller proceeds exactly as before.
 */
export function publishCandidate(deps: EngineDeps, step: store.StepRow, at: number): PublishResult | null {
  const raw = step.candidate_text;
  const sha = step.candidate_sha;
  if (raw === null || sha === null) return null;

  const front = step.pass === 'front';
  const chapter = front || step.chapter === null ? null : chapterTarget(deps.db, step.chapter, raw);
  const target = front ? frontTarget(deps.db, raw) : chapter;
  if (target === null) refuse('TARGET_MISSING', 409, 'the step has no text to publish');
  // The candidate's sha is the fact the gates answered about; a text that no longer parses to it
  // is not the text they read.
  if (target.sha256 !== sha) {
    refuse('CANDIDATE_MOVED', 409, 'the candidate no longer matches the sha its gates read');
  }
  if (!front && step.chapter !== null && chapter !== null && !frameIntact(step.chapter, chapter.raw)) {
    refuse('FRAME_CHANGED', 409, FRAME_CHANGED_MESSAGE);
  }

  // Gate B on the delta, if the step did not scan at its provisional landing (a step that landed
  // before this rule). A non-releasable hit refuses the publication: nothing is served.
  const state = step.rights_scan === null ? scanStepDelta(step, chapter) : null;
  if (state !== null && state.refusal !== null) {
    refuse('RIGHTS_STOPLIST', 409, state.refusal, { rule: state.rule, block: state.block });
  }

  const changedFromStart = step.start_sha === null || sha !== step.start_sha;
  const ingested: IngestOutcome = changedFromStart
    ? ingestLanding(deps, step, at, raw, {})
    : { rev: null, changed: false, frameRejected: false, planned: null };
  if (ingested.frameRejected && step.chapter !== null) {
    const fresh = chapterTarget(deps.db, step.chapter, raw);
    refuse('FRAME_CHANGED', 409, FRAME_CHANGED_MESSAGE, { intact: frameIntact(step.chapter, fresh.raw) });
  }
  const revAfter = changedFromStart
    ? (ingested.rev ??
      (step.chapter === null
        ? (step.rev_before ?? 0) + 1
        : Math.max(currentRev(deps.db, step.chapter), (step.rev_before ?? 0) + 1)))
    : (step.rev_before ?? 0);
  const measured = measureDelta(step, chapter?.blocks ?? []);

  store.updateStep(deps.db, step.step_id, {
    start_sha: step.start_sha ?? sha,
    landed_at: toIso(at),
    landed_sha: sha,
    rev_after: revAfter,
    blocks_touched: measured.touched,
    chars_delta: measured.delta,
    rights_scan: step.rights_scan ?? state?.stored ?? null,
    // The publication is the end of the candidate: a second close cannot publish it again.
    candidate_text: null,
    candidate_sha: null,
  });
  appendEvent(
    deps.db,
    {
      kind: 'step.landed',
      stepId: step.step_id,
      cascadeId: step.cascade_id,
      chapter: step.chapter,
      isFront: front,
      rev: step.chapter === null ? null : revAfter,
      payload: { sha, revision: false, provisional: true, deltaRatio: measured.ratio },
    },
    at,
  );
  return { rev: revAfter, sha, changed: changedFromStart && ingested.changed };
}

/**
 * BOOK-222 — the text a prompt may quote of a chapter that has a candidate.
 *
 * `POST /internal/text` answers with rows, and the rows are the text the **site serves**. While a
 * pass holds a candidate, the text the pass and its gates must read is the candidate — never the
 * served chapter, and never a version of it the gates were not handed. So the door prefers the
 * candidate of an open step on that chapter; the reader's own view still comes from the rows.
 */
export function candidateViewOf(db: EngineDeps['db'], n: number): ChapterTextView | null {
  const row = db
    .prepare(
      `SELECT candidate_text FROM steps
        WHERE chapter = ? AND outcome IS NULL AND candidate_text IS NOT NULL
        ORDER BY at DESC LIMIT 1`,
    )
    .get(n) as { candidate_text: string } | undefined;
  if (row === undefined) return null;
  const parsed = parseChapter(n, normalizeChapterText(row.candidate_text));
  return {
    n,
    title: parsed.title,
    exists: true,
    basis: parsed.basis,
    chars: parsed.chars,
    text: parsed.blocks.length === 0 ? '' : `${chapterBodyOf(parsed.blocks)}\n`,
  };
}
