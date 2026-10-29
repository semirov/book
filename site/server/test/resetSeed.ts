/**
 * The seeded book BOOK-137 wipes: three chapters (ch01 written and kept by BOOK-202, the frozen
 * finale, ch08 written), one identity with its session, one filing that became a change, and the
 * engine row of every table the reset drops. It lives apart from the
 * test so the reset suite reads as assertions rather than as SQL, and so the same seed can be
 * counted from two sides — the literals below and the response.
 *
 * BOOK-187: `bookFiles()` is the **one-shot import's** input — a fixture tree a test hands to
 * `reconcile`, which is how a book gets into a volume. Nothing reads it after the seed: the
 * reset itself reads rows.
 */

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS, splitSentences } from '@book/shared';

import type { Db } from '../src/db/db.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { touchSentence } from '../src/sentences/store.ts';
import { longProse, type Fixture } from './helpers.ts';

export const AT = '2026-10-25T12:00:00Z';

/** The version the seeded book already published: a reset must move it forward, never back. */
export const SEEDED_STATE_VERSION = 813;

/**
 * The chapters a seeded book has: the frozen finale, one written chapter, and **ch01 written**
 * (BOOK-202) — the launch reset keeps it whole, so a fixture whose ch01 is only the frame would
 * never exercise the rule. `withFrame` leaves a file whose frame already opens the body alone,
 * and the ingest accepts it: the title, the frame sentence and the paragraphs after it.
 */
export function bookFiles(): Record<string, string> {
  return {
    'ch01.md': longProse([FRAME_FIRST_SENTENCE, 'Служебный абзац номер один. Это служебный текст главы первой.']),
    [`ch${String(TOTAL_CHAPTERS).padStart(2, '0')}.md`]: FRAME_LAST_SENTENCE,
    'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
  };
}

/**
 * The sentences the ingest wrote for the wiped chapters, recomputed with the shared segmenter
 * rather than read from the store: the dry run's answer and the fixture's own number must not be
 * the same SQL. ch01 and the finale are excluded, like `blocks` in the counters (BOOK-202).
 */
function seededSentences(db: Db): number {
  const blocks = db
    .prepare(
      `SELECT b.text AS text FROM blocks b JOIN chapters c ON c.n = b.chapter
        WHERE c.basis = 0 AND c.n <> 1 ORDER BY b.chapter, b.idx`,
    )
    .all() as Array<{ text: string }>;
  return blocks.reduce((sum, block) => sum + splitSentences(block.text).length, 0);
}

export function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

export function seedBook(target: Fixture): string {
  const db = target.db;
  const owner = upsertIdentity(db, { yandexSub: 'yandex-owner', displayName: 'Филипп Семиров', at: AT }).id;
  db.prepare('INSERT INTO sessions (id, identity_id, cookie_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    'ses_one',
    owner,
    'cookie-hash',
    AT,
    '2026-11-25T12:00:00Z',
  );
  // The first sheet is canon the reset keeps. This fixture has no `00-front.md`, so the row is
  // seeded directly — what matters here is that the wipe does not touch `front_matter`.
  db.prepare(
    `INSERT INTO front_matter (id, title, about, rev, sha256, about_sha256, updated_at)
     VALUES (1, 'Книга', 'Служебная аннотация для проверки.', 1, 'sha-front', 'sha-about', ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, number)
     VALUES ('cmt_one', ?, 8, 'Филипп Семиров', 'Служебное замечание.', 'sha-body', 'hash-one', 'accepted', ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
  ).run(owner, AT);
  db.prepare('INSERT INTO comment_events (comment_id, at, type) VALUES (?, ?, ?)').run('cmt_one', AT, 'posted');
  db.prepare('INSERT INTO feedback_batches (id, created_at, count, path, comment_ids) VALUES (?, ?, ?, ?, ?)').run(
    'bat_one',
    AT,
    1,
    'batches/bat_one.jsonl',
    '["cmt_one"]',
  );
  db.prepare(
    `INSERT INTO changes (id, kind, intervention_kind, chapter, intent, source_comment, base_rev, base_sha256,
                          base_blocks, scope_hint, status, enqueued_at)
     VALUES ('chg_one', 'accepted_comment', 'document', 8, 'Служебное намерение.', 'cmt_one', 1, 'sha-base',
             '[]', 'phrase', 'done', ?)`,
  ).run(AT);
  db.prepare('INSERT INTO change_events (change_id, at, type) VALUES (?, ?, ?)').run('chg_one', AT, 'queued');
  db.prepare(
    `INSERT INTO cascades (id, change_id, status, outcome, budget, opened_at, closed_at)
     VALUES ('csc_one', 'chg_one', 'closed', 'consistent', '{}', ?, ?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome, at, closed_at,
                        hseq_from, hseq_to)
     VALUES ('stp_one', 'csc_one', 1, 0, 'forward', 'cascade', 8, '9', 'rewritten', ?, ?, 2, 3)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO gate_dispatches (step_id, role, session, dispatched_at, expires_at)
     VALUES ('stp_one', 'editor', 'fwd', ?, ?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO gate_verdicts (step_id, role, verdict, findings, model, at)
     VALUES ('stp_one', 'editor', 'HOLDS', '[]', 'test-model', ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO leases (id, step_id, change_id, cascade_id, lane, chapter, is_front, kind, session, expected_rev,
                         acquired_at, heartbeat_at, expires_at, released_at, release_reason)
     VALUES ('lea_one', 'stp_one', 'chg_one', 'csc_one', 'forward', 8, 0, 'cascade', 'fwd', 1, ?, ?, ?, ?, 'landed')`,
  ).run(AT, AT, AT, AT);
  db.prepare(
    `INSERT INTO change_impact (change_id, chapters_touched, chapters_rewritten, blocks_changed, chars_added,
                                chars_removed, overwrites, seams, depth_down, depth_up, tokens, cost_rub, ms,
                                from_hseq, to_hseq, computed_at)
     VALUES ('chg_one', '[8]', '[8]', 2, 120, 40, 0, '[]', 0, 0, 100, 0.5, 1000, 2, 3, ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO reconciles (chapter, rev, at, actor, because, validation, hseq)
     VALUES (8, 2, ?, 'operator', 'проверка после восстановления', '{}', 2)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO contributions (identity_id, edits, chars, share, first_at, last_at, computed_at)
     VALUES (?, 1, 100, 0.5, ?, ?, ?)`,
  ).run(owner, AT, AT, AT);
  db.prepare(
    `INSERT INTO contribution_history (identity_id, day, edits, chars, share, measured_at)
     VALUES (?, '2026-10-25', 1, 100, 0.5, ?)`,
  ).run(owner, AT);
  // BOOK-176: one row of every ledger table. The counters must count them and the wipe must
  // remove them; the offsets are nominal — this fixture writes no prose of its own.
  // BOOK-DOC-77: the extraction run the fact and the edges below name. It goes first: `facts` and
  // `fact_dependency` carry a foreign key to it, and the wipe removes it after both.
  db.prepare(
    `INSERT INTO extraction_runs (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status)
     VALUES ('run_one', 8, 1, 'sha-text', 'sha-prompt', 'test-model', 'extract', ?, 'ok')`,
  ).run(AT);
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                        invalidated_by_change, created_at, key, sentence, extracted_by,
                        superseded_by_extraction)
     VALUES ('fct_one', 8, 'state', 'Служебное утверждение.', 'служебный термин', 8, NULL, NULL, ?,
             '', '', '', NULL)`,
  ).run(AT);
  // BOOK-185: a second fact, so the edges below point at two real rows rather than at themselves,
  // and a row the run retired — the two supersession columns mean different things.
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                        invalidated_by_change, created_at, key, sentence, extracted_by,
                        superseded_by_extraction)
     VALUES ('fct_two', 8, 'date', 'Служебная дата.', NULL, 8, NULL, NULL, ?, 'date:2065-09-14',
             'Акт 14.09.2065 подшит в дело.', 'run_one', 'run_one')`,
  ).run(AT);
  // BOOK-185 / ADR-040: two edges — one retired by the other, which the run also records. The
  // successor is written first: `superseded_by` is a real reference, resolved when the row lands.
  db.prepare(
    `INSERT INTO fact_dependency (id, "from", "to", chapter, kind, stance, line, statement, origin,
                                  step_id, rev, superseded_by, retired_by_run, at, extracted_by)
     VALUES ('fdp_two', 'fct_two', 'fct_one', 8, 'cause', 'plain', NULL,
             'Служебная дата — причина служебного утверждения.', 'registered', 'stp_one', 1,
             NULL, NULL, ?, 'run_one')`,
  ).run(AT);
  db.prepare(
    `INSERT INTO fact_dependency (id, "from", "to", chapter, kind, stance, line, statement, origin,
                                  step_id, rev, superseded_by, retired_by_run, at, extracted_by)
     VALUES ('fdp_one', 'fct_two', 'fct_one', 8, 'document', 'plain', NULL,
             'Служебная дата подшита в служебное утверждение.', 'registered', 'stp_one', 1,
             'fdp_two', 'run_one', ?, '')`,
  ).run(AT);
  db.prepare(
    `INSERT INTO threads (id, label, direction, opened_at_chapter, closed_at_chapter, state, extracted_by)
     VALUES ('thr_one', 'служебная линия', 'forward', 8, NULL, 'opened', 'run_one')`,
  ).run();
  db.prepare(
    `INSERT INTO thread_events (thread_id, chapter, kind, fact_id, note, at)
     VALUES ('thr_one', 8, 'opened', 'fct_one', NULL, ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, thread_id,
                           resolved_by_change, role, witness, edge_path)
     VALUES ('bkd_seed:1:0', 'ch08#seed0001', 8, 0, 7, 'fact', 'fct_one', NULL, NULL, 'assert',
             'Тестов', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO literals (literal, raw, block_id, span_id, chapter, mention_kind, start, end)
     VALUES ('2065-09-14', '14.09.2065', 'ch08#seed0001', 'bkd_seed:1:0', 8, 'date', 0, 10)`,
  ).run();
  // ADR-044: the ingest segmented every published block, so the sentence rows are already there;
  // one touch makes the ledger non-empty, so the wipe has provenance to remove as well.
  const sentence = db
    .prepare(
      `SELECT s.id AS id FROM sentences s
         JOIN blocks b ON b.id = s.block_id
         JOIN chapters c ON c.n = b.chapter
        WHERE c.basis = 0 AND c.n <> 1 AND s.erased_at IS NULL
        ORDER BY b.chapter, b.idx, s.idx LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (sentence !== undefined) {
    touchSentence(db, { sentenceId: sentence.id, changeId: 'chg_one', kind: 'born', at: AT });
  }
  // BOOK-173: one plan. A reset must remove it before the change it priced, or the wipe commits
  // a dangling reference.
  db.prepare(
    `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, iterations, created_at)
     VALUES ('pln_seed', 'chg_one', 8, 'ripple', '{}', '[]', '{}', '[]', ?)`,
  ).run(AT);
  const rate = db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)');
  rate.run(`edit:id:${owner}`, 1_760_000_000_000);
  rate.run('edit:ip:hash-one', 1_760_000_000_000);
  const meta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  for (const [key, value] of [
    ['state_version', String(SEEDED_STATE_VERSION)],
    ['last_scan_at', AT],
    ['engine.alerts', '{}'],
    ['rights.backfill', 'done'],
    ['engine.heartbeat', AT],
  ] as const) {
    meta.run(key, value);
  }
  db.prepare('UPDATE lane SET holder = ?, heartbeat_at = ?').run('chg_one', AT);
  return owner;
}

/** The counters, in the documented print order (also the order the tests assert). */
export const CONTENT_KEYS = [
  'chapters',
  'blocks',
  'revisions',
  'changes',
  'change_events',
  'cascades',
  'steps',
  'gate_verdicts',
  'gate_dispatches',
  'leases',
  'change_impact',
  'comments',
  'comment_events',
  'feedback_batches',
  'reconciles',
  'events',
  'front_revisions',
  'block_lineage',
  'block_versions',
  // BOOK-176: the ledger's own rows are content too — a reset that left them behind would
  // publish rows pointing at a book that no longer exists.
  'facts',
  // BOOK-DOC-77: the extraction run ledger and BOOK-185's edges — the audit of the pass that
  // wrote the graph, and the graph itself.
  'extraction_runs',
  'fact_dependency',
  'threads',
  'thread_events',
  'mentions',
  'literals',
  // ADR-044: sentences are content, not a projection — a surviving row would name a span of text
  // the reset deleted.
  'sentences',
  'sentence_touches',
  // BOOK-173: the frozen plans of the ripple.
  'change_plans',
  'overwrites',
  'contributions',
  'contribution_history',
  'rate_events',
  'meta',
  'lane',
];

export const ZEROS: Record<string, number> = Object.fromEntries(CONTENT_KEYS.map((key) => [key, 0]));

/**
 * The counts the seeded book holds, read with plain SQL of their own — the seeded numbers are
 * literals, the reconcile-derived shapes are counted from what the projection wrote.
 */
export function expectedCounts(target: Fixture): Record<string, number> {
  const db = target.db;
  return {
    chapters: 1,
    blocks: count(db, 'SELECT COUNT(*) AS n FROM blocks WHERE chapter = 8'),
    revisions: 1,
    changes: 1,
    change_events: 1,
    cascades: 1,
    steps: 1,
    gate_verdicts: 1,
    gate_dispatches: 1,
    leases: 1,
    change_impact: 1,
    comments: 1,
    comment_events: 1,
    feedback_batches: 1,
    reconciles: 1,
    // BOOK-202: the import writes one `chapter.created` event per written chapter — ch01 and
    // ch08 in this fixture — and the log is wiped whole. A literal on purpose: a wipe that
    // stopped deleting events must fail this, so the number is not counted from the rows.
    events: 2,
    front_revisions: 0,
    block_lineage: count(db, 'SELECT COUNT(*) AS n FROM block_lineage WHERE chapter <> 1'),
    block_versions: count(db, 'SELECT COUNT(*) AS n FROM block_versions WHERE chapter <> 1'),
    facts: 2,
    extraction_runs: 1,
    fact_dependency: 2,
    threads: 1,
    thread_events: 1,
    mentions: 1,
    literals: 1,
    sentences: seededSentences(db),
    sentence_touches: 1,
    change_plans: 1,
    overwrites: 0,
    contributions: 1,
    contribution_history: 1,
    rate_events: 2,
    meta: 1,
    lane: 1,
  };
}
