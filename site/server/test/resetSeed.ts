/**
 * The seeded book BOOK-137 wipes: three chapters, one identity with its session, one filing that
 * became a change, and the engine row of every table the reset drops. It lives apart from the
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
 * The three chapters a seeded book has: the two frame slots and one written chapter, as the
 * one-shot import reads them. `reconcile` turns them into rows and that is the last time any of
 * this exists as a file.
 */
export function bookFiles(): Record<string, string> {
  return {
    'ch01.md': FRAME_FIRST_SENTENCE,
    [`ch${String(TOTAL_CHAPTERS).padStart(2, '0')}.md`]: FRAME_LAST_SENTENCE,
    'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
  };
}

/**
 * The sentences the ingest wrote for the written chapters, recomputed with the shared segmenter
 * rather than read from the store: the dry run's answer and the fixture's own number must not be
 * the same SQL. The frame slots are excluded, like `blocks` in the counters.
 */
function seededSentences(db: Db): number {
  const blocks = db
    .prepare(
      `SELECT b.text AS text FROM blocks b JOIN chapters c ON c.n = b.chapter
        WHERE c.basis = 0 ORDER BY b.chapter, b.idx`,
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
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
     VALUES ('cmt_one', ?, 8, 'Филипп Семиров', 'Служебное замечание.', 'sha-body', 'hash-one', 'accepted', ?)`,
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
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                        invalidated_by_change, created_at)
     VALUES ('fct_one', 8, 'state', 'Служебное утверждение.', 'служебный термин', 8, NULL, NULL, ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO threads (id, label, direction, opened_at_chapter, closed_at_chapter, state)
     VALUES ('thr_one', 'служебная линия', 'forward', 8, NULL, 'opened')`,
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
        WHERE c.basis = 0 AND s.erased_at IS NULL
        ORDER BY b.chapter, b.idx, s.idx LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (sentence !== undefined) {
    touchSentence(db, { sentenceId: sentence.id, changeId: 'chg_one', kind: 'born', at: AT });
  }
  // BOOK-173: one edge and its plan. A reset must remove the graph before the facts it names and
  // the plan before the change it priced, or the wipe commits a dangling reference.
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
     VALUES ('fct_two', 8, 'state', 'Второе служебное утверждение.', 'второй термин', 8, ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO edges (id, from_fact, to_fact, chapter, kind, on_component, evidence, origin, created_at)
     VALUES ('edg_seed', 'fct_one', 'fct_two', 8, 'follows', 'value', 'служебная связь', 'backfill', ?)`,
  ).run(AT);
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
  'threads',
  'thread_events',
  'mentions',
  'literals',
  // ADR-044: sentences are content, not a projection — a surviving row would name a span of text
  // the reset deleted.
  'sentences',
  'sentence_touches',
  // BOOK-173: the ripple's graph and its plans.
  'edges',
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
    events: 1,
    front_revisions: 0,
    block_lineage: count(db, 'SELECT COUNT(*) AS n FROM block_lineage'),
    block_versions: count(db, 'SELECT COUNT(*) AS n FROM block_versions'),
    facts: 2,
    threads: 1,
    thread_events: 1,
    mentions: 1,
    literals: 1,
    sentences: seededSentences(db),
    sentence_touches: 1,
    edges: 1,
    change_plans: 1,
    overwrites: 0,
    contributions: 1,
    contribution_history: 1,
    rate_events: 2,
    meta: 1,
    lane: 1,
  };
}
