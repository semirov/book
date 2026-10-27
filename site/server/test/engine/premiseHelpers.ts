import type { InterventionKind } from '@book/shared';

import { insertComment, readCommentRow } from '../../src/comments/repo.ts';
import { acceptComment } from '../../src/feedback/accept.ts';
import type { Db } from '../../src/db/db.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';

/** BOOK-7 test fixtures shared by `premise.test.ts` and `premiseApi.test.ts`. */

export const AT = '2026-10-25T09:00:00Z';

let seq = 0;

export function fixtureOf(): Fixture {
  const fixture = createEngineFixture();
  fixture.db
    .prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_viewer', 'yandex-viewer', 'Аня', ?, ?)`,
    )
    .run(AT, AT);
  return fixture;
}

export function seed(
  db: Db,
  input: { chapter: number; body?: string; proposedText?: string | null; kind?: InterventionKind | null },
): string {
  seq += 1;
  const id = `cmt_BOOK7${String(seq).padStart(19, '0')}`;
  insertComment(db, {
    id,
    identityId: 'idn_viewer',
    chapter: input.chapter,
    blockId: null,
    blockIndex: null,
    baseRev: null,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: input.body ?? 'К этой главе есть замысел.',
    proposedText: input.proposedText ?? null,
    interventionKind: input.kind ?? null,
    bodySha: `sha-${id}`,
    flags: [],
    ipHash: 'ip-hash',
    status: 'new',
    guard: null,
    reason: null,
    createdAt: AT,
    idemKey: null,
  });
  // BOOK-9: only a recorded `FITS` may become a change; this fixture records it directly.
  db.prepare(`UPDATE comments SET audit_verdict = 'FITS', audited_at = ?, audited_by = 'triage-1' WHERE id = ?`).run(
    AT,
    id,
  );
  return id;
}

export function accept(db: Db, id: string, intent: string) {
  return acceptComment(db, {
    comment: readCommentRow(db, id)!,
    intent,
    at: AT,
    reason: 'входит в книгу',
  });
}

export function change(db: Db, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown>;
}

/** Chapters 1..4 written, so the forward lane's next draft slot is chapter 5. */
export function fourWritten(fixture: Fixture): void {
  for (let n = 1; n <= 4; n += 1) {
    fixture.writeChapterBlocks(n, `Глава ${n}`, [`Служебный абзац главы ${n}. Он не является текстом книги.`]);
  }
}
