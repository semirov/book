/**
 * Seeding helpers for the push tests (BOOK-189).
 *
 * Every push test starts from a real database built by the real migration, and the rows it needs
 * are the rows the rest of the site writes: an identity, a filing, a change, a device. These
 * helpers write exactly those, so a test never invents a shape the engine could not produce —
 * `sendPassEvent`'s recipient is the filing's author, and to test that the filing has to be a
 * real comment row.
 *
 * The outbox helpers are separate on purpose: the drain's tests are about draining, so they put a
 * row in the queue directly instead of going through the claim and the quiet rules first.
 */

import type { Db } from '../../src/db/db.ts';
import { insertComment } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { upsertSubscription } from '../../src/push/repo.ts';

/** A Wednesday, 12:00 UTC: far enough from midnight that a day boundary is a deliberate move. */
export const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;

let seq = 0;

export function resetIds(): void {
  seq = 0;
}

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${String(seq).padStart(3, '0')}`;
}

/** The site's own ISO format: UTC, second precision. */
export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export function seedIdentity(db: Db, name: string): string {
  return upsertIdentity(db, { yandexSub: `yandex-${name}`, displayName: name, at: iso(T0) }).id;
}

export function seedDevice(db: Db, identityId: string, endpoint: string, at = T0): void {
  upsertSubscription(db, identityId, { endpoint, p256dh: 'a'.repeat(64), auth: 'b'.repeat(20) }, at);
}

/** A filing by `identityId` on `chapter`, as the posting service stores one. */
export function seedComment(db: Db, identityId: string, chapter: number): string {
  const id = nextId('cmt');
  insertComment(db, {
    id,
    identityId,
    chapter,
    blockId: null,
    blockIndex: null,
    baseRev: null,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'Служебное замечание для проверки.',
    proposedText: null,
    interventionKind: null,
    bodySha: `sha-${id}`,
    flags: [],
    ipHash: 'ip-hash',
    status: 'delivered',
    guard: null,
    reason: null,
    createdAt: iso(T0),
    idemKey: null,
  });
  return id;
}

export type ChangeSeed = {
  chapter: number;
  sourceComment: string | null;
  status?: 'pending' | 'done' | 'void' | 'escalated' | 'failed' | 'stale' | 'processing';
  outcome?: string | null;
  premise?: number;
};

export function seedChange(db: Db, input: ChangeSeed): string {
  const id = nextId('chg');
  db.prepare(
    `INSERT INTO changes
       (id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks, scope_hint,
        premise, status, outcome, enqueued_at)
     VALUES (?, 'accepted_comment', ?, 'служебный замысел', ?, 0, 'sha', '[]', 'chapter', ?, ?, ?, ?)`,
  ).run(
    id,
    input.chapter,
    input.sourceComment,
    input.premise ?? 0,
    input.status ?? 'pending',
    input.outcome ?? null,
    iso(T0),
  );
  return id;
}

export type OutboxRow = {
  id: number;
  identity_id: string;
  chapter: number;
  title: string;
  body: string;
  url: string;
  tag: string;
  at: string;
  expires_at: string;
  attempts: number;
  next_at: string;
};

export function outbox(db: Db): OutboxRow[] {
  return db.prepare('SELECT * FROM push_outbox ORDER BY id').all() as OutboxRow[];
}

export function claims(db: Db): Array<{ identity_id: string; chapter: number; kind: string }> {
  return db.prepare('SELECT identity_id, chapter, kind FROM push_log').all() as Array<{
    identity_id: string;
    chapter: number;
    kind: string;
  }>;
}

/** An outbox row written straight into the queue: the drain's tests are about draining. */
export function enqueue(
  db: Db,
  identityId: string,
  chapter: number,
  atMs: number,
  overrides: Partial<OutboxRow> = {},
): number {
  const row = db
    .prepare(
      `INSERT INTO push_outbox
         (identity_id, chapter, title, body, url, tag, at, expires_at, attempts, next_at)
       VALUES (?, ?, ?, 'Бланк', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      identityId,
      chapter,
      overrides.title ?? `глава ${String(chapter)} написана`,
      overrides.url ?? `/ch/${String(chapter)}`,
      overrides.tag ?? `ch${String(chapter)}`,
      overrides.at ?? iso(atMs),
      overrides.expires_at ?? iso(atMs + DAY),
      overrides.attempts ?? 0,
      overrides.next_at ?? iso(atMs),
    );
  return Number(row.lastInsertRowid);
}
