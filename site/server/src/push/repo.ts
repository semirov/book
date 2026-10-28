/**
 * The reader's devices (BOOK-189).
 *
 * A push subscription is a **capability**: whoever holds the endpoint can post to that device
 * without asking anyone. So every function here is either «store it, tied to one identity» or
 * «forget it» — there is no read that hands an endpoint to a caller outside this module and the
 * drain, and no query that lists a reader's devices for a response. The routes only ever ask for
 * a count (`countSubscriptions`), so a stolen session cannot walk away with another reader's
 * handles: there is no route, no field and no error that returns one.
 *
 * Two rules the schema cannot state:
 *
 *   · **re-subscribing the same device is an update.** The browser hands the same endpoint again
 *     after a reload, and it must refresh the keys and the owner rather than mint a second row —
 *     `endpoint` is `UNIQUE`, and the upsert is an `ON CONFLICT` on it;
 *   · **a reader has at most `MAX_DEVICES`**. A phone, a laptop, a tablet, a work machine and one
 *     spare is the whole honest list; past it the oldest row is deleted, because a cap that
 *     refused the newest device would leave a reader stuck with the one they lost.
 */

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { ulid } from '../util/ulid.ts';

/** One device's push capability, in the only shape this module lets out. */
export type PushSubscription = { endpoint: string; p256dh: string; auth: string };

/** Devices per reader. The sixth subscription evicts the oldest one. */
export const MAX_DEVICES = 5;

/**
 * Stores (or refreshes) one device and trims the reader's list to the cap. The id is minted from
 * the upsert's own moment, so a list ordered by `created_at` is a list ordered by «when each
 * device last subscribed» — which is exactly the order the cap evicts in.
 */
export function upsertSubscription(
  db: Db,
  identityId: string,
  subscription: PushSubscription,
  at: number,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(endpoint) DO UPDATE SET
         identity_id = excluded.identity_id,
         p256dh      = excluded.p256dh,
         auth        = excluded.auth,
         created_at  = excluded.created_at`,
    ).run(`psh_${ulid(at)}`, identityId, subscription.endpoint, subscription.p256dh, subscription.auth, toIso(at));

    // `created_at` is second precision, so devices subscribed inside one second tie; `rowid`
    // breaks the tie by insertion order, which is the order the rows were created in.
    const extra = db
      .prepare(
        `SELECT id FROM push_subscriptions WHERE identity_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
      )
      .all(identityId, MAX_DEVICES) as Array<{ id: string }>;
    for (const row of extra) deleteById(db, row.id);
  })();
}

/**
 * Forgets one device (only if it belongs to this identity) or every device of the identity, and
 * answers the number left. The ownership check is part of the DELETE, not a read before it: a
 * route that read the row first could still be raced into deleting another reader's device.
 */
export function deleteSubscription(db: Db, identityId: string, endpoint?: string): number {
  if (endpoint === undefined) {
    db.prepare('DELETE FROM push_subscriptions WHERE identity_id = ?').run(identityId);
  } else {
    db.prepare('DELETE FROM push_subscriptions WHERE identity_id = ? AND endpoint = ?').run(identityId, endpoint);
  }
  return countSubscriptions(db, identityId);
}

/**
 * The push service said 410: the endpoint is dead and any owner of it is owed a cleanup, so this
 * one deliberately ignores ownership. It is never reachable from a request body — only from the
 * drain, which got the endpoint out of the row it just tried to use.
 */
export function deleteSubscriptionByEndpoint(db: Db, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/** The devices a notification may be sent to; ordered so the newest device is tried first. */
export function subscriptionsOf(db: Db, identityId: string): PushSubscription[] {
  return db
    .prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE identity_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(identityId) as PushSubscription[];
}

export function countSubscriptions(db: Db, identityId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE identity_id = ?')
    .get(identityId) as { n: number };
  return row.n;
}

/** Whether this reader ever subscribed — the quiet rule that must not burn a chapter's claim. */
export function hasSubscription(db: Db, identityId: string): boolean {
  return db.prepare('SELECT 1 AS one FROM push_subscriptions WHERE identity_id = ? LIMIT 1').get(identityId) !== undefined;
}

function deleteById(db: Db, id: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
}
