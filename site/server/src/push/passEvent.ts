/**
 * The reader's chapter event (BOOK-189) — the one push decision the engine makes, and it is
 * made of rows only.
 *
 * The engine is a deterministic state machine with no network (ADR-012), so «notify the reader»
 * cannot be a send here. It is a **claim and a queue**: at most one notification per identity
 * and chapter, ever, plus an outbox row the site process drains. That split is what makes a
 * replayed engine safe — a re-run of a land finds the claim already taken and does nothing.
 *
 * **Nothing here is deferred.** An event is evaluated once, when it happens; nothing re-emits it
 * later. So a rule that refuses one (no device, the day's cap, a state that is not an answer)
 * does not postpone the notification — it drops it, and the reader learns the chapter's state
 * from the chapter page. That is why the rules below are about *not* writing a claim unless the
 * reader can hear this event *now*: a claim written for an announcement nobody received would
 * also swallow the next, real answer for the same chapter (the claim is per chapter, not per
 * event).
 *
 * The rules, in the order they are asked, and why each one exists:
 *
 *   1. **the recipient is always the filing's author.** Not the reader of the chapter, not the
 *      subscribers to a topic: the person who asked about this chapter reads the answer to
 *      their own filing. A change with no source comment (an operator edit, a continuity sweep)
 *      has no such person and notifies nobody;
 *   2. **a reader with no device gets no claim.** The claim is permanent; writing one for an
 *      announcement that could not be delivered would mark the chapter as «already told» and
 *      block the `decision` event that later carries the real answer;
 *   3. **three a day.** The claim protects one chapter, not a reader's evening: a cascade that
 *      settles several chapters at once must not turn the phone into a feed. The cap counts the
 *      day's claims and stops *before* writing one — and the chapters past it are dropped, not
 *      queued: the book page is where a reader catches up;
 *   4. **duplicate is a database fact.** `INSERT OR IGNORE` on the primary key `(identity_id,
 *      chapter)`: whoever writes second learns it lost, and a chapter is never announced twice;
 *   5. **silence is decided before the claim.** A `decision` event whose change is not finished
 *      (`escalated`, `processing`, `stale`, `failed`) returns `no-recipient` without touching
 *      `push_log`, so the eventual answer can still be spoken (`copyOf` names the states);
 *   6. **the queue row is written in the same transaction as the claim**, so there is no state
 *      where a chapter is «claimed but forgotten».
 *
 * The payload is deliberately four fields. «глава N написана» is the reader's answer, and the
 * title, the body and the link carry no identity, no display name, no comment id, no change id
 * and no token: a notification is rendered on a lock screen, and a lock screen is public.
 *
 * **Nothing here may throw.** Push is observability, not a fact the pass depends on (the same
 * rule `writer/stages.ts` follows): a broken push table must never stop a land or a close, so
 * every failure is `{ queued: false, reason: 'error' }` and a silent, unlogged one at that — the
 * sender logs counts, the engine logs nothing about push.
 */

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';
import { hasSubscription } from './repo.ts';

export type PassEvent =
  | { kind: 'landed'; chapter: number; changeId: string }
  | { kind: 'decision'; changeId: string }
  | { kind: 'commentDecision'; commentId: string; rejected: true };

export type PassEventResult =
  | { queued: false; reason: 'no-recipient' | 'no-device' | 'duplicate' | 'throttled' | 'error' }
  | { queued: true; chapter: number };

/** The book's own title, used as the notification's body: a push says «Бланк» and the chapter. */
const BODY = 'Бланк';

/** How many push claims one reader may take in one UTC day. */
export const PUSH_DAILY_LIMIT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A notification that could not be delivered within a day is yesterday's news. */
const OUTBOX_TTL_MS = DAY_MS;

type Recipient = { identityId: string; chapter: number; status: string | null; outcome: string | null };

type OutboxCopy = { title: string; chapter: number };

export function sendPassEvent(db: Db, event: PassEvent, nowMs: number): PassEventResult {
  try {
    return db.transaction((): PassEventResult => run(db, event, nowMs))();
  } catch {
    return { queued: false, reason: 'error' };
  }
}

function run(db: Db, event: PassEvent, nowMs: number): PassEventResult {
  // One read answers both questions the rest of the function asks: whose filing it is, and — for
  // a decision — what that decision was. The engine calls this *after* the row was written, so
  // reading it here reads the answer being announced, never a guess.
  const recipient = recipientOf(db, event);
  if (recipient === null) return { queued: false, reason: 'no-recipient' };

  const copy = copyOf(event, recipient);
  if (copy === null) return { queued: false, reason: 'no-recipient' };

  // The order of the next two checks is the contract: a silent event must not write the claim,
  // because the claim is per chapter and would swallow the answer that comes later.
  if (!hasSubscription(db, recipient.identityId)) return { queued: false, reason: 'no-device' };
  // Three a day: this chapter is dropped, not deferred — nothing re-emits it, and the page says
  // what landed. Stopping before the claim keeps the day's quota for the events that follow.
  if (claimsToday(db, recipient.identityId, nowMs) >= PUSH_DAILY_LIMIT) {
    return { queued: false, reason: 'throttled' };
  }

  const at = toIso(nowMs);
  const claimed = db
    .prepare(
      `INSERT OR IGNORE INTO push_log (identity_id, chapter, kind, at) VALUES (?, ?, ?, ?)`,
    )
    .run(recipient.identityId, copy.chapter, kindOf(event), at).changes;
  if (claimed === 0) return { queued: false, reason: 'duplicate' };

  db.prepare(
    `INSERT INTO push_outbox
       (identity_id, chapter, title, body, url, tag, at, expires_at, attempts, next_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    recipient.identityId,
    copy.chapter,
    copy.title,
    BODY,
    `/ch/${String(copy.chapter)}`,
    `ch${String(copy.chapter)}`,
    at,
    toIso(nowMs + OUTBOX_TTL_MS),
    at,
  );
  return { queued: true, chapter: copy.chapter };
}

/** Who asked. A `landed` event also has to be about the chapter the change was filed for. */
function recipientOf(db: Db, event: PassEvent): Recipient | null {
  if (event.kind === 'commentDecision') {
    const row = db
      .prepare('SELECT chapter, identity_id FROM comments WHERE id = ?')
      .get(event.commentId) as { chapter: number; identity_id: string } | undefined;
    return row === undefined
      ? null
      : { identityId: row.identity_id, chapter: row.chapter, status: null, outcome: null };
  }
  const row = db
    .prepare(
      `SELECT changes.chapter AS chapter, changes.status AS status, changes.outcome AS outcome,
              comments.identity_id AS identity_id
         FROM changes JOIN comments ON comments.id = changes.source_comment
        WHERE changes.id = ?`,
    )
    .get(event.changeId) as
    | { chapter: number; status: string; outcome: string | null; identity_id: string }
    | undefined;
  if (row === undefined) return null;
  // A cascade step rewrites a neighbouring chapter; the reader asked about theirs. A step for
  // another chapter is not an answer to their filing and notifies nobody.
  if (event.kind === 'landed' && row.chapter !== event.chapter) return null;
  return { identityId: row.identity_id, chapter: row.chapter, status: row.status, outcome: row.outcome };
}

/**
 * What the notification says — and, just as important, **which answers are not spoken at all**.
 *
 * The register has three ends for a filing, and only two of them are an answer to the reader:
 *
 *   · `done` — it landed (`applied`/`adapted` → «глава N написана») or it became paperwork
 *     (`registered` → «правка по главе N принята»). Any other `done` outcome says nothing: this
 *     build does not know the word, and a guess would be a lie on a lock screen;
 *   · `void` — the change was refused (`dropped`, `superseded`): «правка по главе N отклонена» is
 *     the truthful word and the reader is owed it;
 *   · everything else is **not an answer**: `escalated` means «остановлено — нужно решение», the
 *     operator still has to act; `processing`, `pending`, `stale` and `failed` are states on the
 *     way. Announcing any of them as «отклонена» would tell a reader their filing was refused
 *     while the engine is waiting for a decision about it.
 *
 * Silence has to happen **before** the claim, not after it: the claim is permanent per chapter,
 * so a silent event that took it would swallow the real answer that comes later.
 */
function copyOf(event: PassEvent, recipient: Recipient): OutboxCopy | null {
  const n = recipient.chapter;
  if (event.kind === 'landed') return { title: `глава ${String(n)} написана`, chapter: n };
  if (event.kind === 'commentDecision') return { title: `правка по главе ${String(n)} отклонена`, chapter: n };

  if (recipient.status === 'done') {
    if (recipient.outcome === 'applied' || recipient.outcome === 'adapted') {
      return { title: `глава ${String(n)} написана`, chapter: n };
    }
    if (recipient.outcome === 'registered') {
      return { title: `правка по главе ${String(n)} принята`, chapter: n };
    }
    return null;
  }
  if (recipient.status === 'void') return { title: `правка по главе ${String(n)} отклонена`, chapter: n };
  // escalated, failed, stale, processing, pending — the engine has not finished answering.
  return null;
}

function kindOf(event: PassEvent): 'landed' | 'decision' {
  return event.kind === 'landed' ? 'landed' : 'decision';
}

/** Claims this reader has taken since 00:00 UTC of `nowMs`'s day. */
function claimsToday(db: Db, identityId: string, nowMs: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM push_log WHERE identity_id = ? AND at >= ?')
    .get(identityId, toIso(startOfUtcDay(nowMs))) as { n: number };
  return row.n;
}

/** 00:00:00 UTC of the day `nowMs` falls in — the day the cap counts. */
export function startOfUtcDay(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}
