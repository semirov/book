import type { Db } from '../../src/db/db.ts';
import { reconcile, type ReconcileReport } from '../../src/ingest/reconcile.ts';
import { toIso } from '../../src/util/time.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';

const HOUR_MS = 3_600_000;

export const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

export const FRONT = `Без названия\n\n${ABOUT}\n`;

/**
 * The one clock the history fixtures write at — absolute, never the wall clock.
 *
 * A test that seeded a reader's lease and then ingested at `new Date()` passed only while
 * the fixture's lease window was still in the future: once it lapsed, the write had no live
 * lease, so the log said «правка вне процесса», the revision carried no `change_id`, and
 * `change_impact` counted zero blocks. Both sides now come from this instant (`seedChange`
 * opens its lease an hour before it and expires it fourteen hours after), so attribution,
 * the paragraph chain and the impact projection are deterministic.
 */
export const FIXTURE_NOW = new Date('2026-10-25T09:30:00Z');

export function ingest(fixture: Fixture, name: string, text: string, now: Date = FIXTURE_NOW): ReconcileReport {
  fixture.write(name, text);
  return reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir, now });
}

export function lastHseq(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM events').get() as { hseq: number }).hseq;
}

export function chapterFile(n: number, paragraphs: string[] = [], title?: string): string {
  return longProse(paragraphs, title ?? `Глава ${n}`);
}

/** A 67-chapter book, one paragraph each — the invariant the time-travel check runs on. */
export function fullBook(): Record<string, string> {
  const files: Record<string, string> = { '00-front.md': FRONT };
  for (let n = 1; n <= 67; n += 1) {
    files[`ch${String(n).padStart(2, '0')}.md`] = `Глава ${n}\n\nАбзац главы ${n}: служебный текст для проверки, он не из книги.`;
  }
  return files;
}

export type SeededChange = { changeId: string; leaseId: string; stepId: string; commentId: string; identityId: string };

/**
 * A reader's change holding a live lease on one chapter — the state the engine produces
 * before a writer lands (§6A.11). Inserted directly so a history test does not need a model.
 */
export function seedChange(
  db: Db,
  options: {
    index: number;
    chapter: number;
    label?: string;
    cascadeId?: string;
    acquiredAt?: string;
    expiresAt?: string;
    identity?: boolean;
  },
): SeededChange {
  const index = options.index;
  const label = options.label ?? 'Аня';
  const changeId = `chg_${index}`;
  const stepId = `stp_${index}`;
  const leaseId = `lea_${index}`;
  const commentId = `cmt_${index}`;
  const identityId = `idt_${index}`;
  const acquiredAt = options.acquiredAt ?? toIso(FIXTURE_NOW.getTime() - HOUR_MS);
  const expiresAt = options.expiresAt ?? toIso(FIXTURE_NOW.getTime() + 14 * HOUR_MS);
  const withIdentity = options.identity !== false;

  if (withIdentity) {
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES (?, ?, ?, '2026-10-20T09:00:00Z', '2026-10-25T08:00:00Z')`,
    ).run(identityId, `sub-${index}`, label);
  }
  db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
     VALUES (?, ?, ?, ?, 'абзац слишком часто', ?, 'iph', 'accepted', '2026-10-24T09:00:00Z')`,
  ).run(commentId, identityId, options.chapter, label, `sha-${index}`);
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks,
                          scope_hint, status, enqueued_at)
     VALUES (?, 'accepted_comment', ?, 'убрать второе упоминание абзаца', ?, 1, 'sha', '[]',
             'phrase', 'processing', '2026-10-25T08:00:00Z')`,
  ).run(changeId, options.chapter, commentId);
  if (options.cascadeId !== undefined) {
    db.prepare(
      `INSERT INTO cascades (id, change_id, status, budget, opened_at)
       VALUES (?, ?, 'open', '{}', '2026-10-25T08:30:00Z')`,
    ).run(options.cascadeId, changeId);
    db.prepare('UPDATE changes SET cascade_id = ? WHERE id = ?').run(options.cascadeId, changeId);
  }
  db.prepare(
    `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, at)
     VALUES (?, ?, 1, 1, 'forward', ?, ?, '5', ?)`,
  ).run(stepId, options.cascadeId ?? null, options.cascadeId === undefined ? 'change' : 'cascade', options.chapter, acquiredAt);
  db.prepare(
    `INSERT INTO leases (id, step_id, change_id, cascade_id, lane, chapter, is_front, kind, session,
                         expected_rev, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, 'forward', ?, 0, ?, 'writer-fwd', 1, ?, ?, ?)`,
  ).run(
    leaseId,
    stepId,
    changeId,
    options.cascadeId ?? null,
    options.chapter,
    options.cascadeId === undefined ? 'change' : 'cascade',
    acquiredAt,
    acquiredAt,
    expiresAt,
  );
  return { changeId, leaseId, stepId, commentId, identityId };
}

/** The writer is done with the chapter: the next change may hold it. */
export function releaseLease(db: Db, leaseId: string, reason = 'done'): void {
  db.prepare('UPDATE leases SET released_at = ?, release_reason = ? WHERE id = ?').run(
    '2026-10-25T09:30:00Z',
    reason,
    leaseId,
  );
}

export type HistoryFixture = Fixture;
export function historyFixture(files: Record<string, string> = {}): HistoryFixture {
  return createFixture(files);
}
