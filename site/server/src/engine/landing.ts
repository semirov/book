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
import { currentRev } from './close.ts';
import { settleLanding, type LandingPlan } from './ripple.ts';
import { readChapterRows, readFrontRows, type ChapterText, type FrontText } from './text.ts';
import * as store from './store.ts';
import type { EngineDeps } from './types.ts';

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
