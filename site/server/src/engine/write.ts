/**
 * `start` and `land` — the two calls that touch a file (ARCHITECTURE.md §6A.4 steps 2–4,
 * §6A.11, §6B.2).
 *
 * `start` is where the writer answers relevance (adapt/drop/void) and where the engine
 * captures the pre-image: the sha it must see change, and the block hashes the delta check
 * compares against. `land` is the only way a write becomes a fact: the engine reads the file
 * itself, refuses an empty chapter, refuses a malformed first sheet, and drops gate verdicts
 * that were given about the previous revision. A re-land of the same content is a no-op, so a
 * retried call cannot duplicate a revision.
 */

import {
  CHAPTER_CHARS,
  FRONT_ANNOTATION_FROZEN,
  NOTE_MAX_CHARS,
  REASON_MAX_CHARS,
  type Relevance,
} from '@book/shared';

import { applyChapterFile, type ApplyChapterResult } from '../ingest/applyChapter.ts';
import { applyFrontFile, type ApplyFrontResult } from '../ingest/applyFront.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { appendChangeEvent, appendEvent } from '../history/log.ts';
import { sha256Hex } from '../util/hash.ts';
import { toIso } from '../util/time.ts';
import { closeStep, currentRev } from './close.ts';
import { changeForStep, measureDelta, safeJson } from './helpers.ts';
import { liveLease, releaseLease } from './leases.ts';
import { needsWriterDecision, withWriterDecision } from './relevance.ts';
import * as store from './store.ts';
import { isWrittenChapter, readChapter, readFront } from './text.ts';
import { refuse, type EngineDeps } from './types.ts';

export type StartOptions = {
  /** The writer's relevance answer, recorded before the text is touched (§6A.7). */
  decision?: 'adapt' | 'drop' | 'void';
  reason?: string;
  /** The narrowed intent, required when the decision is `adapt`. */
  intent?: string;
  now?: number;
};

export type LandOptions = { noWrite?: boolean; rev?: number; now?: number };

export type LandResult = {
  landed: true;
  revAfter: number;
  sha: string;
  changed: boolean;
  deltaRatio: number;
  blocksTouched: number;
};

/**
 * §6F.1: a landing is a revision, and a revision exists in the same transaction as its log
 * entry. `land` therefore publishes the file it just validated through the same ingest the
 * watcher uses — one choke point, so an engine run and an observed write cannot disagree.
 * The ingest is idempotent by sha: if the watcher got there first, it returns `unchanged`.
 */
function ingestLanding(
  deps: EngineDeps,
  step: store.StepRow,
  at: number,
): { rev: number | null; changed: boolean } {
  const dataDir = deps.config.dataDir;
  if (step.pass === 'front') {
    const front = readFront(deps.bookRoot);
    if (!front.exists) return { rev: null, changed: false };
    const result: ApplyFrontResult = applyFrontFile({
      db: deps.db,
      dataDir,
      raw: front.raw,
      mtimeMs: at,
      nowMs: at,
    });
    return { rev: result.rev, changed: result.status !== 'unchanged' };
  }
  if (step.chapter === null) return { rev: null, changed: false };
  const chapter = readChapter(deps.bookRoot, step.chapter);
  if (!chapter.exists) return { rev: null, changed: false };
  const result: ApplyChapterResult = applyChapterFile({
    db: deps.db,
    dataDir,
    n: step.chapter,
    raw: chapter.raw,
    mtimeMs: at,
    nowMs: at,
  });
  if (result.status === 'created' || result.status === 'revised') return { rev: result.rev, changed: true };
  return { rev: null, changed: false };
}

export function createWriteOps(deps: EngineDeps) {
  const { db, bookRoot } = deps;
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

    const front = step.pass === 'front' ? readFront(bookRoot) : null;
    const chapter = step.pass === 'front' || step.chapter === null ? null : readChapter(bookRoot, step.chapter);
    if (step.pass === 'front' && !front?.exists) refuse('FRONT_MISSING', 409, 'the first sheet does not exist yet');
    // A draft starts from nothing; every other pass revises text that must already exist.
    // A basis-only slot (ch01/ch67) is that same nothing — its frozen sentence is not prose.
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
      refuse('ENDING_FROZEN', 409, 'chapter 67 is evaluated, never rewritten (ADR-024)');
    }
    // F025, second door: even a mis-planned `cascade` step may not land inside chapter 67.
    if (step.pass === 'cascade' && step.chapter === 67) {
      refuse('ENDING_FROZEN', 409, 'a ripple evaluates chapter 67; it never rewrites it (ADR-024, F025)');
    }
    if (step.pass === 'draft' && options.noWrite === true) {
      refuse('NOT_WRITTEN', 409, 'a draft must write its slot');
    }

    const front = step.pass === 'front' ? readFront(bookRoot) : null;
    const chapter = step.pass === 'front' || step.chapter === null ? null : readChapter(bookRoot, step.chapter);
    const target = step.pass === 'front' ? front : chapter;
    if (target === null || target.sha256 === '') refuse('TARGET_MISSING', 409, 'the step has no file to land');

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
      refuse('NOT_WRITTEN', 409, 'the file was not written (or holds no paragraphs)');
    } else if (chapter.chars > CHAPTER_CHARS.max) {
      refuse('CHAPTER_TOO_LONG', 409, `chapter is ${chapter.chars} characters; the maximum is ${CHAPTER_CHARS.max}`);
    }

    const sha = target.sha256;
    if (step.landed_at !== null && step.landed_sha === sha) {
      return {
        landed: true,
        revAfter: step.rev_after ?? step.rev_before ?? 0,
        sha,
        changed: false,
        deltaRatio: 0,
        blocksTouched: 0,
      };
    }

    if (step.landed_at !== null) {
      // The text changed after an answer: the old verdicts described a file a gate can no
      // longer see. They are dropped and asked again — no gate blesses unseen text.
      store.deleteVerdicts(db, step.step_id);
      store.deleteDispatch(db, step.step_id, 'editor');
      store.deleteDispatch(db, step.step_id, 'consultant');
    }
    const measured = measureDelta(step, chapter?.blocks ?? []);
    const changedFromStart = step.start_sha === null || sha !== step.start_sha;
    // The revision is published here, with its `hseq` and its cause (§6F.1, §6F.2).
    const ingested = changedFromStart ? ingestLanding(deps, step, at) : { rev: null, changed: false };
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
    return {
      landed: true,
      revAfter,
      sha,
      changed: changedFromStart,
      deltaRatio: measured.ratio,
      blocksTouched: measured.touched,
    };
  }

  return { start, land };
}
