/**
 * The change's verification record (BOOK-173, BOOK-DOC-80): which gates judged it, what the local
 * judge said, what it cost, and whether the safeguard sampled it.
 *
 * The writer owns no database, so the facts travel to the close (`done` → `closeStep`) and land
 * here, inside the close's own transaction: a change whose close did not land must not read as
 * verified. `change_plans` is the row — one per change — and `change_events` is where a fact that
 * arrived later (a re-read that disagreed) is attached, because a plan row is a state and an event
 * is a history.
 *
 * The sampling rule itself is `writer/verify/samples.ts` (pure); this module is the one place that
 * reads `changes.seq`, so the rule is applied once, atomically, and a crash cannot sample twice.
 */

import { z } from 'zod';

import type { Db } from '../../db/db.ts';
import { toIso } from '../../util/time.ts';
import type { GatesMode, GateTrigger } from '../../writer/verify/policy.ts';
import { sampleDue, WRITER_BOOT_KEY, type SampleVerdict } from '../../writer/verify/samples.ts';
import type { Tier1Verdict } from '../../writer/verify/tier1.ts';

/**
 * The body shape `/internal/done` accepts for the record, and the normalisation into the type this
 * module writes. It lives here — next to the record — so the route stays a parser and the ledger
 * keeps one definition of what a verification is.
 */
export const verificationSchema = z.object({
  gatesMode: z.enum(['local only', 'full']),
  why: z
    .enum(['tier0_failed', 'tier1_gap', 'tier1_unsure', 'closure_non_empty', 'chapter_edge', 'wide'])
    .nullable()
    .optional(),
  tier1Verdict: z.enum(['HOLDS', 'GAP', 'UNSURE', 'TIER1_UNPARSED']).nullable().optional(),
  tier1Usd: z.number().min(0).nullable().optional(),
});

export type VerificationBody = z.infer<typeof verificationSchema>;

/** A parsed body → the record; `undefined` stays `undefined` (a caller that states nothing). */
export function normalizeVerification(raw: VerificationBody | undefined): VerificationRecord | undefined {
  if (raw === undefined) return undefined;
  return {
    gatesMode: raw.gatesMode,
    why: raw.why ?? null,
    tier1Verdict: raw.tier1Verdict ?? null,
    tier1Usd: raw.tier1Usd ?? null,
  };
}

export type VerificationRecord = {
  /** `local only` when the full pair was not run; `full` when it was. */
  gatesMode: GatesMode;
  /** Which trigger forced the pair; `null` for a local-only change or a resumed step. */
  why: GateTrigger | null;
  /** The local judge's word; `null` when it was not asked (a rewrite, a resumed step). */
  tier1Verdict: Tier1Verdict | null;
  /** What the Tier 1 call cost; `null` means «not priced», never «free». */
  tier1Usd: number | null;
};

export type SampleRequest = {
  planRowId: string;
  changeId: string;
  chapter: number;
  /** The verdict the sample is compared against. */
  tier1Verdict: string | null;
  requestedAt: string;
};

/**
 * Where a close's verification belongs: the change, the chapter the closing step landed and the
 * step itself. `change_plans` is one row per change, and the row's chapter is the change's own —
 * so the key is `(change_id, chapter)`, and the step is what history says wrote it.
 */
export type VerificationTarget = { changeId: string; chapter: number; stepId: string };

/** Why a verification was not written. A code, so a refusal is never a silence. */
export type VerificationRefusal =
  /** The change has no plan row (a rewrite, a landing that moved no block): nowhere to record it. */
  | 'NO_PLAN'
  /** The row belongs to another chapter — a ripple chapter's close, not the change's own landing. */
  | 'CHAPTER_MISMATCH';

export type VerificationWrite =
  | { written: true; planRowId: string; sampled: boolean }
  | { written: false; refusal: VerificationRefusal };

function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

/** Write the per-process marker once: a marker already standing belongs to a process that filed nothing. */
export function markWriterBoot(db: Db, id: string): void {
  db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run(WRITER_BOOT_KEY, id);
}

/** Is a boot marker still waiting for its first local-only change? */
export function pendingWriterBoot(db: Db): boolean {
  return getMeta(db, WRITER_BOOT_KEY) !== null;
}

/** The marker is consumed by the one change it sampled — once, by that change. */
function consumeWriterBoot(db: Db): void {
  db.prepare('DELETE FROM meta WHERE k = ?').run(WRITER_BOOT_KEY);
}

function seqOf(db: Db, changeId: string): number | null {
  const row = db.prepare('SELECT seq FROM changes WHERE id = ?').get(changeId) as { seq: number } | undefined;
  return row?.seq ?? null;
}

/**
 * Record the verification on the change **and the chapter its close landed on**. Two writes, one
 * meaning: the plan row carries the state (`gates_mode`, the judge's word and price,
 * `sample_requested`), the event carries the trigger and the step, so the record survives a plan
 * written later by another landing and history says which close wrote it.
 *
 * The row is the change's own plan, and a ripple chapter closes a step whose lease carries the
 * origin's `changeId`. Writing there would replace the origin's gates, its judge's word and price,
 * and reset its `sample_requested` — dropping a sample the safeguard had queued and pointing the
 * audit at a chapter nobody verified. So the key is `(change_id, chapter)`: a close that is not
 * the change's own landing writes nothing and answers a code (`CHAPTER_MISMATCH`); a change with
 * no plan row answers `NO_PLAN`. A close that is not the change's own landing may never clear
 * `sample_requested`.
 *
 * `sample_requested` is decided here — and only here — because it needs `changes.seq` and the boot
 * marker. Both are read in the same call that writes it, so two closers cannot each consume the
 * one marker.
 */
export function recordVerification(
  db: Db,
  target: VerificationTarget,
  record: VerificationRecord,
  at: string,
): VerificationWrite {
  const row = db.prepare('SELECT id, chapter FROM change_plans WHERE change_id = ?').get(target.changeId) as
    | { id: string; chapter: number }
    | undefined;
  // A change with no plan has nowhere to queue a sample, and its marker is still owed to the next
  // local-only change.
  if (row === undefined) return { written: false, refusal: 'NO_PLAN' };
  if (row.chapter !== target.chapter) return { written: false, refusal: 'CHAPTER_MISMATCH' };
  const seq = seqOf(db, target.changeId);
  const bootPending = record.gatesMode === 'local only' && pendingWriterBoot(db);
  const sample = record.gatesMode === 'local only' && seq !== null && sampleDue({ seq, bootPending });
  db.prepare(
    `UPDATE change_plans
        SET gates_mode = ?, tier1_verdict = ?, tier1_usd = ?, sample_requested = ?
      WHERE id = ? AND change_id = ? AND chapter = ?`,
  ).run(record.gatesMode, record.tier1Verdict, record.tier1Usd, sample ? 1 : 0, row.id, target.changeId, target.chapter);
  if (bootPending) consumeWriterBoot(db);
  db.prepare('INSERT INTO change_events (change_id, at, type, meta) VALUES (?, ?, ?, ?)').run(
    target.changeId,
    at,
    'gates',
    JSON.stringify({
      gates: record.gatesMode,
      why: record.why,
      tier1: record.tier1Verdict,
      tier1Usd: record.tier1Usd,
      sampleRequested: sample,
      chapter: target.chapter,
      step: target.stepId,
    }),
  );
  return { written: true, planRowId: row.id, sampled: sample };
}

/**
 * The close's one call: record the verification for the chapter the step landed on. `null` means
 * «written, or nothing to write» (no change, no chapter, no record); a string is the refusal code
 * the close carries on its own history, so a write that did not happen is never a silence.
 */
export function closeVerification(
  db: Db,
  changeId: string | null,
  chapter: number | null,
  stepId: string,
  record: VerificationRecord | undefined,
  at: string,
): VerificationRefusal | null {
  if (changeId === null || chapter === null || record === undefined) return null;
  const write = recordVerification(db, { changeId, chapter, stepId }, record, at);
  return write.written ? null : write.refusal;
}

/** The oldest samples nobody has read yet, in the order they were queued. */
export function sampleQueue(db: Db, limit: number): SampleRequest[] {
  const rows = db
    .prepare(
      `SELECT p.id AS planRowId, p.change_id AS changeId, p.chapter AS chapter,
              p.tier1_verdict AS tier1Verdict, p.created_at AS requestedAt
         FROM change_plans p
        WHERE p.sample_requested = 1 AND p.sampled_at IS NULL
        ORDER BY p.created_at, p.id
        LIMIT ?`,
    )
    .all(Math.max(1, Math.trunc(limit))) as SampleRequest[];
  return rows;
}

/** One sample's outcome. `error` leaves the sample queued: a failed read is not a clean read. */
export function recordSample(db: Db, planRowId: string, verdict: SampleVerdict, at: string): void {
  if (verdict === 'error') {
    // The queue is `sample_requested = 1 AND sampled_at IS NULL`; a failed read stays exactly there.
    db.prepare('UPDATE change_plans SET sample_verdict = ? WHERE id = ?').run(verdict, planRowId);
    return;
  }
  db.prepare('UPDATE change_plans SET sample_verdict = ?, sampled_at = ? WHERE id = ?').run(verdict, at, planRowId);
}

/**
 * A disagreement the editor found: the change no longer claims a clean local read. The word says
 * so on the row (`local_only_rechecked`), and the finding is attached as an event — the reader's
 * record is corrected, not deleted.
 */
export function markRechecked(db: Db, planRowId: string): void {
  db.prepare(`UPDATE change_plans SET gates_mode = 'local_only_rechecked' WHERE id = ?`).run(planRowId);
}

/** Attach the editor's finding to the change: an append-only row, one per disagreement. */
export function attachFinding(db: Db, changeId: string, finding: string, at: string): void {
  db.prepare('INSERT INTO change_events (change_id, at, type, meta) VALUES (?, ?, ?, ?)').run(
    changeId,
    at,
    'sample_gap',
    JSON.stringify({ finding: finding.slice(0, 400) }),
  );
}

/** The newest sample verdicts, for the drift test (two gaps in any 20: the judge is drifting). */
export function recentSampleVerdicts(db: Db, limit: number): SampleVerdict[] {
  const rows = db
    .prepare(
      `SELECT sample_verdict AS verdict FROM change_plans
        WHERE sampled_at IS NOT NULL AND sample_verdict IS NOT NULL
        ORDER BY sampled_at DESC, id DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.trunc(limit))) as Array<{ verdict: SampleVerdict }>;
  return rows.map((row) => row.verdict);
}

/** The stamp a sample is written with: ISO, from the injected clock. */
export function sampleAt(now: number): string {
  return toIso(now);
}
