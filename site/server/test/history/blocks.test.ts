import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { reconcile } from '../../src/ingest/reconcile.ts';
import { chapterText, createEngineFixture, type Fixture } from '../engine/helpers.ts';

// Fixture paragraphs: distinct synthetic placeholders, never book text.
// BOOK-137: ch01's file opens on the canon frame, so the first paragraph carries it; the
// chain, the rewrites and the char counts below are still the test's own three paragraphs.
const A = `${FRAME_FIRST_SENTENCE} Первый тестовый абзац: альфа, бета и гамма.`;
const B = 'Второй тестовый абзац: дельта, эпсилон и дзета.';
const C = 'Третий тестовый абзац: эта, тета и йота.';
const B_REWRITTEN = 'Второй тестовый абзац: дельта, эпсилон, дзета и ещё одна буква.';
const D = 'Четвёртый тестовый абзац: каппа, лямбда и мю.';

function ingest(fixture: Fixture, title: string, blocks: string[]): void {
  // The chain is measured, not landed: no `land` gate runs here, so the text is exactly the
  // blocks the test wrote — never padded to a page.
  fixture.writeChapter(1, `${title}\n\n${blocks.join('\n\n')}\n`);
  // The site's ingest is what writes a revision; the engine's `land` calls the same
  // function, and so does the boot scan (a single choke point, §6F.1).
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
}

type ChainRow = { op: string; block_id: string; ver: number; rev: number; replaced_by: string | null };

function chain(fixture: Fixture): ChainRow[] {
  return fixture.db
    .prepare('SELECT op, block_id, ver, rev, replaced_by FROM block_versions WHERE chapter = 1 ORDER BY hseq, ver')
    .all() as ChainRow[];
}

describe('the paragraph chain (§6F.3)', () => {
  it('keeps one identity across a rewrite and records the erasure of a removed paragraph', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      ingest(fixture, 'Тестовая глава', [A, B, C]);
      const first = chain(fixture);
      expect(first).toHaveLength(3);
      expect(first.every((row) => row.op === 'introduced')).toBe(true);

      ingest(fixture, 'Тестовая глава', [A, B_REWRITTEN, D]);
      const second = chain(fixture).filter((row) => row.rev === 2);
      const revised = second.filter((row) => row.op === 'revised');
      const introduced = second.filter((row) => row.op === 'introduced');
      const erased = second.filter((row) => row.op === 'erased');

      // B continues its identity; A was untouched (kept, no new version); D is new.
      expect(revised).toHaveLength(1);
      expect(revised[0]?.ver).toBe(2);
      expect(introduced).toHaveLength(1);
      expect(erased).toHaveLength(1);

      const overwrites = fixture.db
        .prepare('SELECT block_id, replaced_by, by_kind, by_label, previous_cause FROM overwrites ORDER BY id')
        .all() as Array<{
        block_id: string;
        replaced_by: string | null;
        by_kind: string;
        by_label: string;
        previous_cause: string | null;
      }>;
      expect(overwrites).toHaveLength(1);
      // The removed paragraph had a newcomer in its slot: the chain links to it.
      expect(overwrites[0]?.replaced_by).not.toBeNull();
      expect(overwrites[0]?.by_kind).toBe('unattributed');
      expect(overwrites[0]?.by_label).toBe('правка вне процесса');

      const overwriteEvents = fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'overwrite' AND chapter = 1`)
        .get() as { n: number };
      expect(overwriteEvents.n).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('records an erasure with no heir as a removal, not an invented continuation', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      ingest(fixture, 'Тестовая глава', [A, B, C]);
      ingest(fixture, 'Тестовая глава', [A, B]);
      const erased = fixture.db
        .prepare(`SELECT replaced_by FROM block_versions WHERE chapter = 1 AND op = 'erased'`)
        .all() as Array<{ replaced_by: string | null }>;
      expect(erased).toHaveLength(1);
      expect(erased[0]?.replaced_by).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('a second revision of a chapter never duplicates the chain of an unchanged text', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      ingest(fixture, 'Тестовая глава', [A, B]);
      const before = chain(fixture).length;
      // Same text: the ingest is idempotent by sha and writes nothing at all.
      ingest(fixture, 'Тестовая глава', [A, B]);
      expect(chain(fixture)).toHaveLength(before);
      const revisions = fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number };
      expect(revisions.n).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('writes the lineage row for every block that ever existed', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      ingest(fixture, 'Тестовая глава', [A, B]);
      ingest(fixture, 'Тестовая глава', [A, B_REWRITTEN]);
      const lineage = fixture.db
        .prepare('SELECT block_id, first_rev, last_rev, replaced_by, cause_kind FROM block_lineage ORDER BY first_rev')
        .all() as Array<{
        block_id: string;
        first_rev: number;
        last_rev: number | null;
        replaced_by: string | null;
        cause_kind: string;
      }>;
      // Two paragraphs at rev 1; B was rewritten at rev 2 (one new id), A was untouched.
      expect(lineage.length).toBe(3);
      const closed = lineage.filter((row) => row.last_rev !== null);
      expect(closed).toHaveLength(1);
      expect(closed.every((row) => row.replaced_by !== null)).toBe(true);
      const open = lineage.filter((row) => row.last_rev === null);
      expect(open).toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  it('an unchanged chapter text keeps the same block text and title in the event', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      ingest(fixture, 'Тестовая глава', [A, B]);
      const event = fixture.db
        .prepare(`SELECT payload FROM events WHERE kind = 'chapter.created' AND chapter = 1`)
        .get() as { payload: string };
      const payload = JSON.parse(event.payload) as { title: string; chars: number; attributed: boolean };
      expect(payload.title).toBe('Тестовая глава');
      expect(payload.chars).toBe(A.length + B.length);
      expect(payload.attributed).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it('exposes the title line of a written chapter to the chain reader', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      ingest(fixture, 'Тестовая глава', [A]);
      expect(chapterText('Тестовая глава', [A])).toContain('Тестовая глава');
    } finally {
      fixture.close();
    }
  });
});
