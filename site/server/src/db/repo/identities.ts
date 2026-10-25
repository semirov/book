/**
 * Identities (ARCHITECTURE.md §8, ADR-021, §6C.5).
 *
 * One row per Yandex subject. The subject is stored because it is the stable key and is
 * never rendered; the display name is the only public identifier. There is no email, phone,
 * avatar or profile, so a database leak cannot become a list of real people.
 */

import type { Db } from '../db.ts';
import { newIdentityId } from '../../util/ulid.ts';

export type IdentityRow = {
  id: string;
  yandex_sub: string;
  display_name: string;
  hide_from_authors: number;
  blocked: number;
  created_at: string;
  last_seen_at: string;
};

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 32;

/** Whatever the IdP returns becomes a bounded label, never a paragraph. */
export function normalizeDisplayName(raw: string | null | undefined): string {
  const value = (raw ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (value.length < DISPLAY_NAME_MIN) return 'читатель';
  return value.slice(0, DISPLAY_NAME_MAX).trim();
}

export function readIdentity(db: Db, id: string): IdentityRow | undefined {
  return db.prepare('SELECT * FROM identities WHERE id = ?').get(id) as IdentityRow | undefined;
}

export function readIdentityBySubject(db: Db, yandexSub: string): IdentityRow | undefined {
  return db.prepare('SELECT * FROM identities WHERE yandex_sub = ?').get(yandexSub) as IdentityRow | undefined;
}

/**
 * First sighting creates the identity; every later sign-in only refreshes `last_seen_at`
 * and never renames the reader (the display name may be edited in the product later).
 */
export function upsertIdentity(
  db: Db,
  input: { yandexSub: string; displayName: string | null; at: string },
): IdentityRow {
  const existing = readIdentityBySubject(db, input.yandexSub);
  if (existing !== undefined) {
    db.prepare('UPDATE identities SET last_seen_at = ? WHERE id = ?').run(input.at, existing.id);
    return { ...existing, last_seen_at: input.at };
  }

  const id = newIdentityId(Date.parse(input.at));
  const name = normalizeDisplayName(input.displayName);
  try {
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, hide_from_authors, blocked, created_at, last_seen_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
    ).run(id, input.yandexSub, name, input.at, input.at);
  } catch {
    // Two callbacks for one subject: the first row wins, the second reads it back.
    const raced = readIdentityBySubject(db, input.yandexSub);
    if (raced !== undefined) return raced;
    throw new Error('identity could not be stored');
  }
  const created = readIdentity(db, id);
  if (created === undefined) throw new Error('identity could not be stored');
  return created;
}
