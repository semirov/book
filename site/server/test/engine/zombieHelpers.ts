/**
 * Fabrication helpers for the BOOK-235 tests (`zombieSweep.test.ts`, `zombieSweepClaim.test.ts`).
 *
 * The rows these build are the ones a previous build left behind — a legacy `escalated` change, an
 * open step nobody holds, a released lease that still names its change — so they are written raw,
 * the way `wall.test.ts` writes a step that exists before it is closed. Shared by the two test
 * files because the sweep's rules and the claim path's answers are one subject, and a second copy
 * of a fixture drifts from the first.
 */

import { decisiveChange, filingChanges, filingStatus } from '../../src/comments/filingState.ts';
import * as store from '../../src/engine/store.ts';
import { ZOMBIE_GRACE_MS } from '../../src/engine/zombieSweep.ts';
import { toIso } from '../../src/util/time.ts';
import { type Fixture } from './helpers.ts';

export type FabricChange = {
  id: string;
  chapter?: number;
  status?: string;
  /** The pre-refusal vocabulary a legacy row carries (`origin`, `gate_timeout`). */
  outcome?: string | null;
  reason?: string | null;
  attempts?: number;
  premise?: 0 | 1;
  commentId?: string | null;
};

/** A change row as a previous build left it: written raw, never through the queue's own door. */
export function addChange(fixture: Fixture, input: FabricChange): string {
  store.insertChange(fixture.db, {
    id: input.id,
    kind: 'accepted_comment',
    interventionKind: null,
    chapter: input.chapter ?? 3,
    anchor: null,
    intent: `служебная заявка ${input.id}`,
    proposedText: null,
    sourceComment: input.commentId ?? null,
    sourceSession: null,
    baseRev: 0,
    baseSha: 'sha-fixture',
    baseBlocks: '[]',
    scopeHint: 'phrase',
    premise: input.premise ?? 0,
    enqueuedAt: toIso(fixture.clock.now()),
  });
  store.updateChange(fixture.db, input.id, {
    status: input.status ?? 'pending',
    outcome: input.outcome ?? null,
    reason: input.reason ?? null,
    attempts: input.attempts ?? 0,
  });
  return input.id;
}

/** One reader's filing, with the gates its change needs to exist beside it. */
export function addComment(fixture: Fixture, id: string, chapter: number): string {
  fixture.db
    .prepare(
      `INSERT OR IGNORE INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_1', 'sub-1', 'Аня', '2026-10-20T09:00:00Z', '2026-10-25T08:00:00Z')`,
    )
    .run();
  fixture.db
    .prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, number)
       VALUES (?, 'idt_1', ?, 'Аня', 'служебная заявка', 'sha', 'iph', 'accepted', '2026-10-24T09:00:00Z',
               (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
    )
    .run(id, chapter);
  return id;
}

/**
 * An open step nobody holds: the shape a killed process leaves behind. The released lease is
 * what names its change (`changeForStep` reads the latest lease), and it is not live, so
 * `claimOpenStep` would hand the step out again — which is why the sweep closes it.
 */
export function addOpenStep(
  fixture: Fixture,
  input: { id: string; chapter: number; changeId: string | null; ageMs?: number; pass?: string },
): string {
  const at = toIso(fixture.clock.now() - (input.ageMs ?? ZOMBIE_GRACE_MS + 60_000));
  store.insertStep(fixture.db, {
    stepId: input.id,
    cascadeId: null,
    seq: 0,
    wave: 0,
    lane: null,
    pass: input.pass ?? 'change',
    chapter: input.chapter,
    boundary: String(input.chapter),
    seamsIn: '[]',
    revBefore: 0,
    at,
  });
  if (input.changeId !== null) {
    const now = fixture.clock.now();
    store.insertLease(fixture.db, {
      id: `lea_${input.id}`,
      stepId: input.id,
      changeId: input.changeId,
      cascadeId: null,
      lane: null,
      chapter: input.chapter,
      isFront: 0,
      kind: 'change',
      session: 'dead-session',
      expectedRev: 0,
      acquiredAt: toIso(now - ZOMBIE_GRACE_MS * 3),
      heartbeatAt: toIso(now - ZOMBIE_GRACE_MS * 2),
      expiresAt: toIso(now - ZOMBIE_GRACE_MS),
    });
    store.updateLease(fixture.db, `lea_${input.id}`, {
      released_at: toIso(now - ZOMBIE_GRACE_MS),
      release_reason: 'expired',
    });
  }
  return input.id;
}

/** A device that would really receive a push, so «no notification» is a fact and not an absence. */
export function addDevice(fixture: Fixture): void {
  fixture.db
    .prepare(
      `INSERT INTO push_subscriptions (id, identity_id, endpoint, p256dh, auth, created_at)
       VALUES ('psh_1', 'idt_1', 'https://push.example/1', 'key', 'auth', '2026-10-25T09:00:00Z')`,
    )
    .run();
}

/** What the reader's page says about a filing now — the one derived answer. */
export function filingStateOf(fixture: Fixture, commentId: string): string {
  return filingStatus(decisiveChange(filingChanges(fixture.db, commentId, null)), 'accepted');
}

/** Three written chapters: enough for a change, a head and a neighbour to live on. */
export function book(fixture: Fixture): void {
  for (const chapter of [1, 2, 3]) fixture.seedChapterBlocks(chapter, `Глава ${chapter}`, ['Тестовый абзац.']);
}
