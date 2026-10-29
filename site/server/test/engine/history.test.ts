import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { createEngineFixture, runStubStep } from './helpers.ts';

type RevisionRow = {
  chapter: number;
  rev: number;
  hseq: number | null;
  cause_kind: string;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  attributed: number;
};

describe('M6b — the engine writes history, not only files (§6F.1)', () => {
  it('every revision of a scripted run appears in the log with its cause and actor', () => {
    const fixture = createEngineFixture();
    try {
      // 1. Two drafts: the writer's own passes, attributed to a lease.
      runStubStep(fixture, { title: 'Тестовая глава', blocks: ['Тестовый абзац.', 'Это служебный текст.'] });
      runStubStep(fixture, { title: 'Вторая глава', blocks: ['Ещё один служебный абзац для проверки, он не является текстом книги и не содержит литературных образов.'] });

      // 2. A reader's change, its ripple up to chapter 2, then the first sheet.
      fixture.db
        .prepare(
          `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
           VALUES ('idt_9', 'sub-9', 'Аня', '2026-10-20T09:00:00Z', '2026-10-25T08:00:00Z')`,
        )
        .run();
      fixture.db
        .prepare(
          `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, audit_verdict, rights_verdict, number)
           VALUES ('cmt_9', 'idt_9', 1, 'Аня', 'абзац слишком часто', 'sha', 'iph', 'accepted', '2026-10-24T09:00:00Z', 'FITS', 'CLEAR', (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
        )
        .run();
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать второе упоминание абзаца',
        commentId: 'cmt_9',
      });
      runStubStep(fixture, {
        title: 'Тестовая глава',
        blocks: ['Тестовый абзац.'],
        seams: [{ boundary: 2, reason: 'соседняя глава начинается с того же абзаца' }],
      });
      runStubStep(fixture, {
        title: 'Вторая глава',
        blocks: ['Ещё один служебный абзац для проверки, он не является текстом книги и не содержит литературных образов.', 'Добавленный абзац номер два.'],
      });
      runStubStep(fixture, {
        title: 'Название после волны',
        // A wave may retitle the book, never rewrite page 2 (BOOK-DOC-6): the annotation is
        // quoted back byte for byte, and the revision is the title's (§6C.2).
        blocks: [fixture.readFrontBlocks()],
        seams: [],
      });

      const revisions = fixture.db
        .prepare('SELECT chapter, rev, hseq, cause_kind, change_id, cascade_id, step_id, attributed FROM revisions ORDER BY chapter, rev')
        .all() as RevisionRow[];
      expect(revisions.length).toBeGreaterThanOrEqual(4);

      for (const revision of revisions) {
        expect(revision.hseq).not.toBeNull();
        const event = fixture.db
          .prepare('SELECT chapter, rev, kind, author_kind FROM events WHERE hseq = ?')
          .get(revision.hseq) as { chapter: number; rev: number; kind: string; author_kind: string } | undefined;
        expect(event).toBeDefined();
        expect(event?.chapter).toBe(revision.chapter);
        expect(event?.rev).toBe(revision.rev);
        expect(event?.kind).toBe(revision.rev === 1 ? 'chapter.created' : 'chapter.revised');
        // A draft is the writer's pass; an applied change carries the reader's chain.
        expect(event?.author_kind).toBe(revision.change_id === null ? 'writer' : 'reader');
        if (revision.change_id !== null) {
          const actor = fixture.db.prepare('SELECT identity_id, author_label FROM events WHERE hseq = ?').get(revision.hseq) as {
            identity_id: string | null;
            author_label: string;
          };
          expect(actor).toEqual({ identity_id: 'idt_9', author_label: 'Аня' });
        }
      }

      const draft = revisions.find((row) => row.chapter === 1 && row.rev === 1);
      expect(draft).toMatchObject({ cause_kind: 'draft', change_id: null, attributed: 1 });
      expect(draft?.step_id).not.toBeNull();

      const origin = revisions.find((row) => row.chapter === 1 && row.rev === 2);
      expect(origin).toMatchObject({ cause_kind: 'change', change_id: change.id, attributed: 1 });
      expect(origin?.cascade_id).toBeNull();

      const ripple = revisions.find((row) => row.chapter === 2 && row.rev === 2);
      expect(ripple).toMatchObject({ cause_kind: 'cascade', change_id: change.id });
      expect(ripple?.cascade_id).not.toBeNull();

      // The front matter revision is in the log and in `front_revisions` (§6F.2).
      const front = fixture.db.prepare('SELECT rev, hseq, title FROM front_revisions ORDER BY rev DESC LIMIT 1').get() as {
        rev: number;
        hseq: number;
        title: string;
      };
      const frontEvent = fixture.db.prepare('SELECT kind, is_front, rev, cascade_id FROM events WHERE hseq = ?').get(front.hseq) as {
        kind: string;
        is_front: number;
        rev: number;
        cascade_id: string | null;
      };
      expect(frontEvent).toMatchObject({ kind: 'front.revised', is_front: 1, rev: front.rev });
      // The seeded sheet is revision 1; the wave retitled it, page 2 untouched.
      expect(front.rev).toBe(2);
      expect(front.title).toBe('Название после волны');

      // The step's history span is filled from the log (§6F.1: `hseq_from`/`hseq_to`).
      const spans = fixture.db
        .prepare('SELECT step_id, hseq_from, hseq_to FROM steps WHERE outcome IS NOT NULL')
        .all() as Array<{ step_id: string; hseq_from: number | null; hseq_to: number | null }>;
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.hseq_to).toBeGreaterThan(0);
        expect(span.hseq_from === null || span.hseq_from <= (span.hseq_to ?? 0)).toBe(true);
      }
    } finally {
      fixture.close();
    }
  });

  it('a re-land of the same text never duplicates a revision', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Тестовая глава', ['Тестовый абзац.']);
      const first = fixture.engine.land(assignment.leaseId);
      expect(first.changed).toBe(true);
      const before = fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number };

      // A second landing of the same text (a retried call, a recovered session) is a no-op:
      // the applier compares the sha and publishes nothing (BOOK-187).
      const again = fixture.engine.land(assignment.leaseId);
      expect(again.changed).toBe(false);
      expect(again.sha).toBe(first.sha);
      expect(again.revAfter).toBe(first.revAfter);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual(before);
    } finally {
      fixture.close();
    }
  });
});
