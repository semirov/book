/**
 * The scratch ledger a closure is read from (BOOK-DOC-75, BOOK-173 addendum).
 *
 * The experiment needs a *whole-book* closure, and the production database is the reader's: this
 * file builds its own — `:memory:` + `migrate`, the manuscript projected into `chapters`/`blocks`
 * the way the ingest would leave it, then `backfillLedger` over the real files. Nothing is written
 * anywhere: the ledger lives in one process, and `manuscript/` is read only.
 *
 * Why a projection at all: `backfillLedger` reads `chapters` rows and joins `mentions` to `blocks`,
 * so a ledger with no projection cannot name the paragraph a fact sits in. The projection is the
 * minimum the backfill needs — chapter row, block rows, one `introduced` block version each (the
 * span a mention binds to) — and it is built from `parseChapter`, the same parser the lane uses.
 *
 * The closure itself is `buildPlan`'s, unmodified: seeds resolved against live facts, a walk in
 * both directions with no chapter window, the three outcomes. This module adds only the two things
 * a measurement needs — which blocks a filing names, and a summary small enough to print.
 */

import { readFileSync } from 'node:fs';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS, isBasisOnly } from '@book/shared';

import { openDatabase, type Db } from '../../server/src/db/db.ts';
import { migrate } from '../../server/src/db/migrate.ts';
import { parseChapter, normalizeForHash, type ParsedChapter } from '../../server/src/ingest/parseChapter.ts';
import { backfillLedger, type BackfillResult } from '../../server/src/ledger/graph/backfill.ts';
import {
  buildPlan,
  type PlanNode,
  type PlanOutcome,
  type RipplePlan,
} from '../../server/src/ledger/graph/plan.ts';
import { chapterPath } from '../../server/src/engine/text.ts';
import { sha1Hex, sha256Hex } from '../../server/src/util/hash.ts';
import type { Filing } from './spec.ts';

/** The ledger's own clock: a fixed instant, so two runs write the same rows. */
const AT = '2026-10-28T12:00:00Z';

export type Ledger = {
  db: Db;
  /** What the backfill wrote, and how long it took — the closure is only as good as its facts. */
  backfill: BackfillResult;
  backfillMs: number;
  chapters: number;
  close(): void;
};

function chapterNumbers(bookRoot: string): number[] {
  const numbers: number[] = [];
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
    try {
      readFileSync(chapterPath(bookRoot, n), 'utf8');
      numbers.push(n);
    } catch {
      // A slot with no file is a slot: it is not in the projection and cannot be.
    }
  }
  return numbers;
}

/** The ingest's projection, reduced to what the backfill and the plan read. */
function project(db: Db, bookRoot: string): number[] {
  const insertChapter = db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
     VALUES (@n, 1, @title, @sha256, @chars, @blockCount, @basis, @at, @at)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev) VALUES (@id, @n, @idx, @text, @hash, 1, 1)`,
  );
  // Version 1 is the checkpoint (ADR-043 D5), so the text is written the way the ingest writes it.
  const insertVersion = db.prepare(
    `INSERT INTO block_versions
       (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
        change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
     VALUES (@uid, 1, @n, 1, 1, @id, @hash, @chars, 'introduced', NULL, NULL, NULL, NULL,
             'unattributed', 'legacy', NULL, @at, '[]', @text)`,
  );

  const written = chapterNumbers(bookRoot);
  db.transaction(() => {
    for (const n of written) {
      const raw = readFileSync(chapterPath(bookRoot, n), 'utf8');
      const parsed: ParsedChapter = parseChapter(n, raw);
      insertChapter.run({
        n,
        title: parsed.title,
        sha256: sha256Hex(parsed.text),
        chars: parsed.chars,
        blockCount: parsed.blocks.length,
        basis: isBasisOnly(n, raw) ? 1 : 0,
        at: AT,
      });
      if (parsed.basis) continue; // the frame is not prose and holds no facts
      parsed.blocks.forEach((block, idx) => {
        const hash = sha1Hex(normalizeForHash(block.text)).slice(0, 8);
        const uid = `bkd_T${String(n)}_${String(idx)}`;
        insertBlock.run({ id: block.id, n, idx, text: block.text, hash });
        insertVersion.run({ uid, n, id: block.id, hash, chars: block.text.length, text: block.text, at: AT });
      });
    }
  })();
  return written;
}

export function openLedger(bookRoot: string): Ledger {
  const db = openDatabase(':memory:');
  migrate(db);
  const chapters = project(db, bookRoot).length;
  const started = Date.now();
  const backfill = backfillLedger(db, { bookRoot, at: AT });
  const backfillMs = Date.now() - started;
  return { db, backfill, backfillMs, chapters, close: () => db.close() };
}

/** The chapter's text as the ledger projected it — the pre-image a plan is built against. */
export function chapterTextOf(bookRoot: string, chapter: number): string {
  return parseChapter(chapter, readFileSync(chapterPath(bookRoot, chapter), 'utf8')).text;
}

/**
 * The blocks a filing names. Three doors, in the order the filing itself names them: the anchor's
 * own ids while they still point at the same bytes (a stale id does not), the anchor's quote
 * inside one block, then the most distinctive token of the intent (a number or a hyphenated id
 * such as `14-УП`). A filing that names nothing is not guessed at further: it is an empty list.
 */
export function anchorBlocks(parsed: ParsedChapter, filing: Filing): string[] {
  const byId = new Map(parsed.blocks.map((block) => [block.id, block]));
  const named = (filing.anchor?.blockIds ?? []).filter((id) => byId.has(id));
  if (named.length > 0) return named;

  const quote = filing.anchor?.quote ?? null;
  if (quote !== null && quote.trim().length > 0) {
    const hit = parsed.blocks.find((block) => block.text.includes(quote.trim()));
    if (hit !== undefined) return [hit.id];
  }
  // The intent's own fingerprint: the one token that reads like a claim (`14-УП`, `№ 257`).
  const token = (filing.intent.match(/[^\s,.:;!?«»()]+[-–№][^\s,.:;!?«»()]+|\b\d{2,}\b/u) ?? [])[0];
  if (token !== undefined) {
    const hit = parsed.blocks.find((block) => block.text.includes(token));
    if (hit !== undefined) return [hit.id];
  }
  return [];
}

/** The facts the anchor asserts: the seeds a plan is built from. */
export function seedsOf(db: Db, blockIds: readonly string[]): string[] {
  if (blockIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT fact_id AS factId FROM mentions
        WHERE kind = 'fact' AND fact_id IS NOT NULL AND block_id IN (${blockIds.map(() => '?').join(',')})
        ORDER BY fact_id`,
    )
    .all(...blockIds) as Array<{ factId: string }>;
  return rows.map((row) => row.factId);
}

/** What a run prints about a closure — the plan itself is too large for a table. */
export type PlanSummary = {
  outcome: PlanOutcome;
  proven: boolean;
  closureNodes: number;
  closureEdges: number;
  closureChapters: number;
  chaptersTouched: number[];
  mandatory: Array<{ factId: string; chapter: number; reason: string; hops: number; direction: string }>;
  optional: Array<{ factId: string; chapter: number; reason: string; hops: number }>;
  longestPath: number;
  unresolved: string[];
  truncated: boolean;
  walkMs: number;
  digest: string;
  bounds: RipplePlan['bounds'];
};

/** The plan's identity: two plans with the same digest are the same closure. */
export function planDigest(plan: RipplePlan): string {
  return sha256Hex(
    JSON.stringify({
      outcome: plan.outcome,
      proven: plan.proven,
      seeds: plan.seeds.map((seed) => seed.factId),
      nodes: plan.nodes.map((node) => `${node.factId}:${String(node.mandatory)}:${node.reason}`),
      edges: plan.edges,
      chapters: plan.chaptersTouched,
      closure: plan.closureSize,
      unresolved: plan.unresolved,
    }),
  );
}

export function planFor(input: {
  db: Db;
  filing: Filing;
  before: string;
  after: string;
  executed?: readonly string[];
  bounds?: Parameters<typeof buildPlan>[0]['bounds'];
}): { plan: RipplePlan; summary: PlanSummary; anchor: { blocks: number; facts: number } } {
  const parsed = parseChapter(input.filing.chapter, input.before);
  const blocks = anchorBlocks(parsed, input.filing);
  const seeds = seedsOf(input.db, blocks);
  const started = Date.now();
  const plan = buildPlan({
    db: input.db,
    changeId: input.filing.id,
    chapter: input.filing.chapter,
    seeds,
    before: input.before,
    after: input.after,
    ...(input.executed === undefined ? {} : { executed: input.executed }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
  });
  const walkMs = Date.now() - started;
  const mandatory: PlanSummary['mandatory'] = plan.nodes
    .filter((node) => node.mandatory)
    .map((node: PlanNode) => ({
      factId: node.factId,
      chapter: node.chapter,
      reason: node.reason,
      hops: node.hops,
      direction: node.direction,
    }));
  const optional: PlanSummary['optional'] = plan.nodes
    .filter((node) => !node.mandatory)
    .map((node) => ({ factId: node.factId, chapter: node.chapter, reason: node.reason, hops: node.hops }));
  return {
    plan,
    anchor: { blocks: blocks.length, facts: seeds.length },
    summary: {
      outcome: plan.outcome,
      proven: plan.proven,
      closureNodes: plan.closureSize.nodes,
      closureEdges: plan.closureSize.edges,
      closureChapters: plan.closureSize.chapters,
      chaptersTouched: plan.chaptersTouched,
      mandatory,
      optional,
      longestPath: plan.nodes.reduce((max, node) => Math.max(max, node.hops), 0),
      unresolved: plan.unresolved,
      truncated: plan.truncated,
      walkMs,
      digest: planDigest(plan),
      bounds: plan.bounds,
    },
  };
}

/** A fact's own sentence, for the reason line a ripple chapter is patched with. */
export function statementOf(db: Db, factId: string): string | null {
  const row = db.prepare('SELECT statement FROM facts WHERE id = ?').get(factId) as { statement: string } | undefined;
  return row?.statement ?? null;
}

/** How many closure nodes name an irreversible act: the one class a ripple may not touch blind. */
export function irreversibleIn(db: Db, factIds: readonly string[]): number {
  if (factIds.length === 0) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM facts
        WHERE id IN (${factIds.map(() => '?').join(',')}) AND kind IN ('erasure')`,
    )
    .get(...factIds) as { n: number };
  return row.n;
}

/**
 * Frozen frame, read the way `validateAnswer` reads it: ch01 opens on the first sentence, ch42
 * closes on the last, no other chapter carries either. A byte comparison, not a judgement.
 */
export function frameOk(chapter: number, text: string): boolean {
  const parsed = parseChapter(chapter, text);
  const first = FRAME_FIRST_SENTENCE;
  const last = FRAME_LAST_SENTENCE;
  if (chapter === 1) return (parsed.blocks[0]?.text ?? '').startsWith(first);
  if (chapter === TOTAL_CHAPTERS) return (parsed.blocks.at(-1)?.text ?? '').endsWith(last);
  return !parsed.body.includes(first) && !parsed.body.includes(last);
}

/** The whole deterministic plan, printed: this is the research answer, not a side effect. */
export function ledgerLine(summary: PlanSummary): string {
  return [
    `outcome ${summary.outcome}`,
    `closure ${String(summary.closureNodes)} nodes / ${String(summary.closureEdges)} edges / ${String(
      summary.closureChapters,
    )} ch`,
    `chapters [${summary.chaptersTouched.join(', ')}]`,
    `mandatory ${String(summary.mandatory.length)}`,
    `optional ${String(summary.optional.length)}`,
    `longest ${String(summary.longestPath)}`,
    summary.walkMs >= 0 ? `${String(summary.walkMs)} ms` : '',
    summary.proven ? 'proven' : `unproven${summary.unresolved.length > 0 ? ` (${String(summary.unresolved.length)} unresolved)` : ''}`,
  ]
    .filter((part) => part.length > 0)
    .join(' · ');
}

/** The pre-image a dry run plans against: the anchor quote replaced by what the filing asks for. */
export function substituteAfter(bookRoot: string, filing: Filing, quote: string | null): { text: string; source: string } {
  const before = chapterTextOf(bookRoot, filing.chapter);
  const wanted = (filing.proposedText ?? filing.intent).trim();
  if (quote === null || quote.trim().length === 0 || wanted.length === 0) {
    return { text: before, source: 'none (the filing names no substitution)' };
  }
  const at = before.indexOf(quote.trim());
  if (at === -1) return { text: before, source: 'none (the quote is not in the chapter)' };
  return {
    text: `${before.slice(0, at)}${wanted}${before.slice(at + quote.trim().length)}`,
    source: 'dry substitute: the anchor quote replaced by intent/proposed_text',
  };
}
