/**
 * `start` and `land` — the two calls that touch the book's text (ARCHITECTURE.md §6A.4 steps
 * 2–4, §6A.11, §6B.2).
 *
 * `start` is where the writer answers relevance (adapt/drop/void) and where the engine
 * captures the pre-image: the sha it must see change, and the block hashes the delta check
 * compares against. Both come from rows.
 *
 * `land` is the only way a write becomes a fact, and since BOOK-187 the text travels **in the
 * request**: the writer holds the chapter in memory and sends it, so nothing is read from or
 * written to `manuscript/`. The engine still refuses an empty chapter, a malformed first sheet
 * and a moved frame, still drops gate verdicts given about the previous revision, and a re-land
 * of the same content is still a no-op — the ingest is idempotent by sha, so a retried call
 * cannot duplicate a revision. Without a `text` the call re-lands the rows the site already
 * serves; it never falls back to a file.
 */

import {
  CHAPTER_CHARS,
  FRONT_ANNOTATION_FROZEN,
  INTENT_MAX_CHARS,
  NOTE_MAX_CHARS,
  REASON_MAX_CHARS,
  TOTAL_CHAPTERS,
  type Relevance,
  type WriteMode,
} from '@book/shared';

import { frameIntact } from '../ingest/frameGuard.ts';
import { getFrontRow } from '../db/repo/front.ts';
import type { RipplePlan } from '../ledger/graph/plan.ts';
import type { SentencePatchEdit } from '../sentences/transform.ts';
import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { sha256Hex } from '../util/hash.ts';
import { toIso } from '../util/time.ts';
import { closeStep, currentRev } from './close.ts';
import { changeForStep, measureDelta, safeJson } from './helpers.ts';
import { liveLease, releaseLease } from './leases.ts';
import { needsWriterDecision, withWriterDecision } from './relevance.ts';
import { chapterTarget, frontTarget, ingestLanding, type IngestOutcome } from './landing.ts';
import { scanStepDelta } from './rightsScan.ts';
import * as store from './store.ts';
import { isWrittenChapter, readChapterRows, readFrontRows } from './text.ts';
import { refuse, type EngineDeps } from './types.ts';

export type StartOptions = {
  /** The writer's relevance answer, recorded before the text is touched (§6A.7). */
  decision?: 'adapt' | 'drop' | 'void';
  reason?: string;
  /** The narrowed intent, required when the decision is `adapt`. */
  intent?: string;
  now?: number;
};

export type LandOptions = {
  /**
   * The writer's own text, held in memory and sent with the request (BOOK-187). Absent means
   * «re-land the rows»: the same call without a body text, never a file read.
   */
  text?: string;
  /** The first sheet's whole text, for a `front` step — the same rule as `text`. */
  frontRaw?: string;
  noWrite?: boolean;
  rev?: number;
  now?: number;
  /**
   * BOOK-173 §2: the patch this landing applies, as one character edit per block — what lets the
   * ingest keep sentence ids across the write (`sentences/transform.ts`). Absent for a rewrite, a
   * draft or a front sheet: none of them knows where inside a paragraph the text moved.
   */
  sentences?: ReadonlyArray<SentencePatchEdit>;
  /** BOOK-173 §4: the mode the pass ran, recorded with the plan (or, with no plan, on the close). */
  mode?: WriteMode;
  /** BOOK-173 §4: the pass's estimate, frozen with the plan and replaced by the actual at close. */
  estimateUsd?: number;
  /**
   * BOOK-222: hold the text as a **candidate** on the step instead of publishing it. Nothing is
   * served — no blocks, no revision, no push — until the close; a second call with the same sha is
   * a no-op, and a different sha replaces the candidate (the latest attempt wins).
   */
  provisional?: boolean;
};

export type LandResult = {
  landed: true;
  revAfter: number;
  sha: string;
  changed: boolean;
  deltaRatio: number;
  blocksTouched: number;
  /**
   * BOOK-173: the change's ripple plan, computed here because the ledger lives here (§3, §7).
   * Additive: absent on a `noWrite` landing and on every pass that is not a point patch.
   */
  plan?: RipplePlan | null;
  /** BOOK-222: the text is held on the step and nothing was published. */
  provisional?: boolean;
};

/** BOOK-137 — the frame's refusal, spoken by both doors: the guard before the ingest, and the
 * ingest again; the letter of the answer never changes. */
const FRAME_CHANGED_MESSAGE = 'рамка книги: фраза этой главы не меняется — правка остаётся бумагой';

export function createWriteOps(deps: EngineDeps) {
  const { db } = deps;
  const iso = (ms: number): string => toIso(ms);

  const leaseStep = (leaseId: string): { lease: store.LeaseRow; step: store.StepRow } => {
    const lease = liveLease(deps, leaseId);
    const step = store.getStep(db, lease.step_id);
    if (!step) refuse('STEP_NOT_FOUND', 404, `no step ${lease.step_id}`);
    if (step.outcome !== null) refuse('STEP_CLOSED', 409, `step ${step.step_id} is already closed`);
    return { lease, step };
  };

  function start(leaseId: string, options: StartOptions = {}): Record<string, unknown> {
    const at = options.now ?? deps.clock.now();
    const { lease, step } = leaseStep(leaseId);
    const change = changeForStep(db, step);

    if (options.decision) {
      if (!change) refuse('NO_CHANGE', 409, 'a relevance decision belongs to a change');
      const relevance = safeJson<Relevance>(change.relevance);
      if (!relevance) refuse('NO_RELEVANCE', 409, `change ${change.id} has no relevance evidence`);
      const reason = (options.reason ?? '').trim();
      if (reason.length === 0) refuse('INVALID_REASON', 422, 'a relevance decision needs a public reason');
      if (reason.length > REASON_MAX_CHARS) {
        refuse('INVALID_REASON', 422, `reason exceeds ${REASON_MAX_CHARS} characters`);
      }
      if ((relevance.grade === 'fresh' || relevance.grade === 'rebased') && options.decision === 'drop') {
        refuse(
          'RELEVANCE_DECISION',
          422,
          'a change whose base still holds cannot be dropped; answer void only if the goal is already true',
        );
      }
      const merged = withWriterDecision(relevance, options.decision, reason);

      if (options.decision === 'adapt') {
        const intent = (options.intent ?? '').trim();
        if (intent.length === 0) refuse('INVALID_INTENT', 422, 'an adapted change carries its narrowed intent');
        // BOOK-44: the bound holds on this path too — an adapted intent is the goal the next pass
        // receives, so it is refused, never truncated: a shortened goal is a different goal.
        if (intent.length > INTENT_MAX_CHARS) {
          refuse('INVALID_INTENT', 422, `intent is ${intent.length} characters, limit is ${INTENT_MAX_CHARS}`);
        }
        store.updateChange(db, change.id, {
          intent,
          intent_original: change.intent_original ?? change.intent,
          relevance: JSON.stringify(merged),
          outcome: 'adapted',
        });
        appendChangeEvent(db, change.id, 'adapted', { intent, reason }, at);
      } else {
        store.updateChange(db, change.id, {
          relevance: JSON.stringify(merged),
          outcome: options.decision === 'void' ? 'superseded' : 'dropped',
        });
        closeStep(
          deps,
          step.step_id,
          {
            outcome: 'holds',
            seamsOut: [],
            note: reason.slice(0, NOTE_MAX_CHARS),
            model: null,
            tokensIn: 0,
            tokensOut: 0,
            changeStatus: 'void',
            changeOutcome: options.decision === 'void' ? 'superseded' : 'dropped',
            changeReason: reason.slice(0, REASON_MAX_CHARS),
          },
          at,
        );
        releaseLease(db, lease.id, 'holds', at);
        return { leaseId, closed: true, outcome: options.decision === 'void' ? 'superseded' : 'dropped', reason };
      }
    } else if (step.pass === 'change' && change?.relevance) {
      const relevance = safeJson<Relevance>(change.relevance);
      if (relevance && needsWriterDecision(relevance) && relevance.decidedBy === null) {
        refuse('RELEVANCE_DECISION', 409, 'the base moved: decide adapt/drop/void before touching the text', {
          relevance,
        });
      }
    }

    if (step.landed_at !== null) {
      return { leaseId, landed: true, revAfter: step.rev_after, sha: step.landed_sha, changed: false };
    }

    const front = step.pass === 'front' ? readFrontRows(db) : null;
    const chapter = step.pass === 'front' || step.chapter === null ? null : readChapterRows(db, step.chapter);
    if (step.pass === 'front' && !front?.exists) refuse('FRONT_MISSING', 409, 'the first sheet does not exist yet');
    // A draft starts from nothing; every other pass revises text that must already exist.
    // A basis-only slot (ch01/ch42) is that same nothing — its frozen sentence is not prose.
    if (step.pass !== 'draft' && chapter !== null && !isWrittenChapter(chapter)) {
      refuse('CHAPTER_EMPTY', 409, `глава ${step.chapter} ещё не написана`);
    }
    const sha = step.pass === 'front' ? (front?.sha256 ?? '') : (chapter?.sha256 ?? '');
    const pre =
      step.pass === 'front'
        ? (front?.blocks ?? []).map((text) => ({ hash: text.slice(0, 24), chars: text.length }))
        : (chapter?.blocks ?? []).map((block) => ({ hash: block.hash, chars: block.text.length }));
    store.updateStep(db, step.step_id, {
      start_sha: sha,
      pre_blocks: JSON.stringify(pre),
      rev_before: step.rev_before ?? lease.expected_rev,
    });
    return {
      leaseId,
      stepId: step.step_id,
      chapter: step.pass === 'front' ? 'front' : step.chapter,
      expectedRev: lease.expected_rev,
      sha,
      chars: pre.reduce((sum, block) => sum + block.chars, 0),
    };
  }

  function land(leaseId: string, options: LandOptions = {}): LandResult {
    const at = options.now ?? deps.clock.now();
    const { step } = leaseStep(leaseId);
    if (step.pass === 'ending' && options.noWrite !== true) {
      refuse('ENDING_FROZEN', 409, `chapter ${String(TOTAL_CHAPTERS)} is evaluated, never rewritten (ADR-024)`);
    }
    // F025, second door: even a mis-planned `cascade` step may not land inside the last chapter.
    if (step.pass === 'cascade' && step.chapter === TOTAL_CHAPTERS) {
      refuse(
        'ENDING_FROZEN',
        409,
        `a ripple evaluates chapter ${String(TOTAL_CHAPTERS)}; it never rewrites it (ADR-024, F025)`,
      );
    }
    if (step.pass === 'draft' && options.noWrite === true) {
      refuse('NOT_WRITTEN', 409, 'a draft must write its slot');
    }

    const supplied = step.pass === 'front' ? options.frontRaw : options.text;
    const front = step.pass === 'front' ? frontTarget(db, supplied) : null;
    const chapter =
      step.pass === 'front' || step.chapter === null ? null : chapterTarget(db, step.chapter, supplied);
    const target = step.pass === 'front' ? front : chapter;
    if (target === null || target.sha256 === '') {
      refuse('TARGET_MISSING', 409, 'the step has no text to land');
    }

    if (options.noWrite === true) {
      if (step.pass === 'draft') refuse('NOT_WRITTEN', 409, 'a draft must write its slot');
      if (chapter !== null && !isWrittenChapter(chapter)) {
        refuse('CHAPTER_EMPTY', 409, 'an empty chapter cannot be landed');
      }
      store.updateStep(db, step.step_id, {
        start_sha: step.start_sha ?? target.sha256,
        landed_at: iso(at),
        landed_sha: target.sha256,
        rev_after: step.rev_before ?? 0,
      });
      appendEvent(
        db,
        {
          kind: 'step.landed',
          stepId: step.step_id,
          cascadeId: step.cascade_id,
          chapter: step.chapter,
          isFront: step.pass === 'front',
          payload: { noWrite: true },
        },
        at,
      );
      return {
        landed: true,
        revAfter: step.rev_before ?? 0,
        sha: target.sha256,
        changed: false,
        deltaRatio: 0,
        blocksTouched: 0,
      };
    }

    if (step.pass === 'front') {
      // Page 2 is the owner's basis (BOOK-DOC-6): a wave may retitle the book, never rewrite
      // the annotation. The published annotation is the reference — a file whose annotation
      // hash differs is refused here by name, before any shape check can pass it through.
      const published = getFrontRow(db);
      const basis = published !== undefined && published.about.length > 0 ? published.about : null;
      if (basis !== null && front !== null && front.aboutSha256 !== sha256Hex(basis)) {
        refuse(
          FRONT_ANNOTATION_FROZEN,
          409,
          'страница 2 — основа: волна может изменить только название',
          { annotationSha256: sha256Hex(basis) },
        );
      }
      if (front === null || !front.exists || front.title === null || front.about === null) {
        refuse('INVALID_FRONT', 422, 'the first sheet needs a title ≤80 chars and an annotation of 300–4 000 chars in up to 12 blocks', {
          problems: front?.problems ?? [],
        });
      }
    } else if (chapter === null || !isWrittenChapter(chapter)) {
      refuse('NOT_WRITTEN', 409, 'the chapter was not written (or holds no paragraphs)');
    } else if (chapter.chars < CHAPTER_CHARS.floor) {
      // Canon: the floor is a limit, not a hint, and this is the second choke point (the
      // validator is the first). A basis-only slot never reaches this branch — it is not a
      // written chapter — so the frozen frame of ch01/ch42 keeps its exemption. The engine
      // refuses; it never pads the text to pass a limit.
      refuse(
        'CHAPTER_TOO_SHORT',
        409,
        `chapter is ${chapter.chars} characters; the minimum is ${CHAPTER_CHARS.floor} (F007)`,
      );
    } else if (chapter.chars > CHAPTER_CHARS.max) {
      refuse('CHAPTER_TOO_LONG', 409, `chapter is ${chapter.chars} characters; the maximum is ${CHAPTER_CHARS.max} (F007)`);
    }

    // BOOK-137: before the text becomes a revision, the frame must be the frame. The refusal
    // names the rule and says what happens instead — the filing stays paperwork.
    if (step.pass !== 'front' && step.chapter !== null && chapter !== null && !frameIntact(step.chapter, chapter.raw)) {
      refuse('FRAME_CHANGED', 409, FRAME_CHANGED_MESSAGE);
    }

    const sha = target.sha256;
    if (step.landed_at !== null && step.landed_sha === sha) {
      // The text the step already serves: nothing to write, and — asked as a candidate — nothing
      // that a put-back would have to undo.
      return {
        landed: true,
        ...(options.provisional === true ? { provisional: true as const } : {}),
        revAfter: step.rev_after ?? step.rev_before ?? 0,
        sha,
        changed: false,
        deltaRatio: 0,
        blocksTouched: 0,
      };
    }

    // BOOK-61 — Gate B on the prose surface. The question is asked of the *delta* only: the
    // blocks whose hash is absent from the pre-image `start` captured. A range that did not
    // move keeps the verdict it had, and a chapter that already passed is not re-judged whole
    // (BOOK-DOC-42 §1). A land that moves the sha is answered here, before anything is written,
    // so a refused chapter leaves no partial state behind.
    const state = scanStepDelta(step, chapter);
    if (state.refusal !== null) refuse('RIGHTS_STOPLIST', 409, state.refusal, { rule: state.rule, block: state.block });

    // BOOK-222 — the lane's own landing is a **candidate**: the text is validated here (size,
    // frame, the rights scan of its delta) and held on the step, and *nothing* is published. The
    // reader keeps the chapter the site already serves until the close; a gate reads the candidate,
    // and a refusal drops it without a revision to take back. A resumed step may hold a new
    // candidate too — nothing is served before the close, so it never publishes first.
    if (options.provisional === true) {
      if (supplied === undefined) {
        refuse('TARGET_MISSING', 409, 'a provisional land carries its text — there is nothing to serve');
      }
      if (step.candidate_sha === sha) {
        // The same attempt asked again: one candidate, one sha, nothing else to write.
        return {
          landed: true,
          provisional: true,
          revAfter: step.rev_before ?? 0,
          sha,
          changed: false,
          deltaRatio: 0,
          blocksTouched: 0,
        };
      }
      // A different sha is a new attempt: the verdicts described the text no gate can see now.
      // A **resumed** step may also already serve an older landing — its verdicts described that
      // text, not the candidate, so they go the same way. The dispatch stays, so a late answer is
      // `CANDIDATE_MOVED` instead of a blessing.
      if (step.candidate_sha !== null || (step.landed_sha !== null && step.landed_sha !== sha)) {
        store.deleteVerdicts(db, step.step_id);
      }
      const measured = measureDelta(step, chapter?.blocks ?? []);
      store.updateStep(db, step.step_id, {
        start_sha: step.start_sha ?? sha,
        candidate_text: target.raw,
        candidate_sha: sha,
        blocks_touched: measured.touched,
        chars_delta: measured.delta,
        rights_scan: state.stored,
      });
      return {
        landed: true,
        provisional: true,
        revAfter: step.rev_before ?? 0,
        sha,
        changed: true,
        deltaRatio: measured.ratio,
        blocksTouched: measured.touched,
      };
    }

    if (step.landed_at !== null) {
      // The text changed after an answer: the old verdicts described a file a gate can no
      // longer see. They are dropped and asked again — no gate blesses unseen text.
      store.deleteVerdicts(db, step.step_id);
      store.deleteDispatch(db, step.step_id, 'editor');
      store.deleteDispatch(db, step.step_id, 'consultant');
      // The scan described that same file: a moved sha is scanned afresh below.
      store.updateStep(db, step.step_id, { rights_scan: null });
    }
    const measured = measureDelta(step, chapter?.blocks ?? []);
    const changedFromStart = step.start_sha === null || sha !== step.start_sha;
    // The revision is published here, with its `hseq` and its cause (§6F.1, §6F.2). Only a text
    // the step brought is published: without one the rows already hold their revision, and
    // re-applying the rows' own canonical text would invent a second one for the same prose.
    const ingested: IngestOutcome =
      supplied !== undefined && changedFromStart
        ? ingestLanding(deps, step, at, target.raw, options)
        : { rev: null, changed: false, frameRejected: false, planned: null };
    // BOOK-137, second read: the guard above read the text once and the applier reads it again,
    // so a text that moved in between publishes nothing. The guard's question is asked of the
    // target as it stands now — the detail says whether it already flipped back — and the step
    // records no revision at all: inventing a `revAfter` here would call a landing a revision
    // the site never served.
    if (ingested.frameRejected && step.chapter !== null) {
      const fresh = chapterTarget(db, step.chapter, supplied);
      refuse('FRAME_CHANGED', 409, FRAME_CHANGED_MESSAGE, {
        intact: frameIntact(step.chapter, fresh.raw),
      });
    }
    const revAfter = changedFromStart
      ? (ingested.rev ??
        (step.chapter === null
          ? (step.rev_before ?? 0) + 1
          : Math.max(options.rev ?? 0, currentRev(db, step.chapter), (step.rev_before ?? 0) + 1)))
      : (step.rev_before ?? 0);
    store.updateStep(db, step.step_id, {
      start_sha: step.start_sha ?? sha,
      landed_at: iso(at),
      landed_sha: sha,
      rev_after: revAfter,
      blocks_touched: measured.touched,
      chars_delta: measured.delta,
      rights_scan: state.stored,
    });
    appendEvent(
      db,
      {
        kind: 'step.landed',
        stepId: step.step_id,
        cascadeId: step.cascade_id,
        chapter: step.chapter,
        isFront: step.pass === 'front',
        rev: step.chapter === null ? null : revAfter,
        payload: { sha, revision: step.landed_at !== null, deltaRatio: measured.ratio },
      },
      at,
    );
    // BOOK-189/BOOK-219: nothing is announced here. `land` publishes text the pass may still take
    // back (a rights refusal, a gate that never answered), so the reader is told the chapter
    // landed at the close — `closeStep` sends that event once the verdicts are in, and a step
    // that closes by restore says nothing about a landing.
    return {
      landed: true,
      revAfter,
      sha,
      changed: changedFromStart,
      deltaRatio: measured.ratio,
      blocksTouched: measured.touched,
      ...(ingested.planned === null ? {} : { plan: ingested.planned.plan }),
    };
  }

  return { start, land };
}
