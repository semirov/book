import { describe, expect, it } from 'vitest';

import type { AuthorContributorDto } from '@book/shared';

import { compareContributors, readAuthors } from '../src/authors/contributions.ts';
import { countContributors, createAuthorsCount } from '../src/authors/count.ts';
import { readMyTrace, survivedRevisions } from '../src/authors/trace.ts';
import { publicAlias } from '../src/util/alias.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { releaseLease, seedChange } from './history/helpers.ts';
import { createFixture, type Fixture } from './helpers.ts';
import { reconcile } from '../src/ingest/reconcile.ts';

const FRONT =
  'Без названия\n\n' +
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

// Fixture prose: neutral repeated sentences, never book text.
const AUTHOR_TEXT =
  'Тестовая глава\n\n' +
  'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';

function ingest(fixture: Fixture, name: string, text: string): void {
  fixture.write(name, text);
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir, now: new Date('2026-10-25T09:00:00Z') });
}

describe('the authors list (§6C.5)', () => {
  it('gives the author the remainder and never sums above 1', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      // A reader's change holds a live lease, writes the chapter, then lets go.
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.author.label).toBe('Филипп Семиров');
      expect(authors.contributors).toHaveLength(1);
      const [anya] = authors.contributors;
      expect(anya?.label).toBe('Аня');
      // Audit m3: a reader is published as `sha256(identityId)` truncated, not as the key.
      expect(anya?.identityId).toBe(publicAlias(seeded.identityId));
      expect(anya?.identityId).not.toBe(seeded.identityId);
      expect(JSON.stringify(authors)).not.toContain(seeded.identityId);
      expect(anya?.edits).toBe(1);
      expect(anya?.chars).toBeGreaterThan(0);
      expect(authors.totalChars).toBe((anya?.chars ?? 0) + authors.author.chars);

      // The author is the remainder: the two shares fill the book exactly, never over.
      expect(authors.sum).toBeLessThanOrEqual(1);
      expect(authors.sum).toBeCloseTo(1, 6);
      expect(authors.author.share + (anya?.share ?? 0)).toBeCloseTo(authors.sum, 6);
    } finally {
      fixture.close();
    }
  });

  it('is deterministic: the same database gives the same list twice', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);

      const first = readAuthors(fixture.db, 'Филипп Семиров');
      const second = readAuthors(fixture.db, 'Филипп Семиров');
      expect(second).toEqual(first);
    } finally {
      fixture.close();
    }
  });

  it('floors every share to six decimals so the printed column cannot exceed the book', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      const shares = [authors.author.share, ...authors.contributors.map((item) => item.share)];
      for (const share of shares) expect(Number(share.toFixed(6))).toBe(share);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(1);
    } finally {
      fixture.close();
    }
  });

  it('does not list a reader who asked to be hidden, and gives their text to the author', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);

      const before = readAuthors(fixture.db, 'Филипп Семиров');
      expect(before.contributors).toHaveLength(1);

      fixture.db.prepare('UPDATE identities SET hide_from_authors = 1 WHERE id = ?').run(seeded.identityId);
      const after = readAuthors(fixture.db, 'Филипп Семиров');
      expect(after.contributors).toHaveLength(0);
      expect(after.author.share).toBeGreaterThan(before.author.share);
      expect(after.author.share).toBe(1);
      // The measurement itself is not hidden: the panel still counts the reader (§6C.5 rule 5).
      expect(after.measured).toBe(before.measured);
    } finally {
      fixture.close();
    }
  });

  it('orders by share: the biggest trace in the final text comes first', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const anya = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, anya.leaseId);

      const boris = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Борис' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.\n\nТестовый абзац номер два. Это служебный текст, он не является текстом книги.`);
      releaseLease(fixture.db, boris.leaseId);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors.map((item) => item.label).sort()).toEqual(['Аня', 'Борис']);
      const shares = authors.contributors.map((item) => item.share);
      expect([...shares].sort((left, right) => right - left)).toEqual(shares);
    } finally {
      fixture.close();
    }
  });

  it('breaks a tie by the reader’s first change, then by label — one stable order', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      // Two readers with an equal surviving trace: the tie-break decides the order.
      const anya = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      releaseLease(fixture.db, anya.leaseId);
      const boris = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Борис' });
      releaseLease(fixture.db, boris.leaseId);
      fixture.db
        .prepare(`UPDATE changes SET enqueued_at = '2026-10-01T08:00:00Z' WHERE id = 'chg_2'`)
        .run();
      for (const [uid, identityId] of [
        ['bkd_anya', anya.identityId],
        ['bkd_boris', boris.identityId],
      ] as const) {
        fixture.db
          .prepare(
            `INSERT INTO block_versions
               (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
                change_id, step_id, actor_kind, actor_label, identity_id, at)
             VALUES (?, 1, 1, 1, 900, ?, 'h', 100, 'introduced', NULL, NULL,
                     NULL, NULL, 'reader', 'читатель', ?, '2026-10-25T09:00:00Z')`,
          )
          .run(uid, `ch01#${uid}`, identityId);
      }

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors.map((item) => item.label)).toEqual(['Борис', 'Аня']);
      expect(authors.contributors[0]?.share).toBe(authors.contributors[1]?.share);
      expect(authors.author.share).toBeLessThan(1);
      expect(authors.sum).toBeLessThanOrEqual(1);
    } finally {
      fixture.close();
    }
  });

  it('lists no reader whose text did not survive: the list is the surviving text, not the log', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors).toEqual([]);
      expect(authors.author.share).toBe(1);
      // The reader is still measured and keeps their own trace; only the row is gone.
      expect(authors.measured).toBe(1);
      expect(readMyTrace(fixture.db, seeded.identityId).edits).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('starts as one author and no contributors: an empty book is not a co-authorship', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors).toEqual([]);
      expect(authors.totalChars).toBe(0);
      expect(authors.author.share).toBe(1);
      expect(authors.sum).toBeLessThanOrEqual(1);
      expect(authors.measuredAt).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('publishes no erosion series: the curve is the reader’s own view, not the list’s', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);

      fixture.db
        .prepare(
          `INSERT INTO contribution_history (identity_id, day, edits, chars, share, measured_at)
           VALUES (?, '2026-10-24', 1, 10, 0.01, '2026-10-24T12:00:00Z')`,
        )
        .run(seeded.identityId);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      // The public row has no series field at all: the curve is the reader's own view.
      expect(authors.contributors[0]).toEqual({
        identityId: authors.contributors[0]?.identityId,
        label: 'Аня',
        edits: 1,
        chars: authors.contributors[0]?.chars,
        share: authors.contributors[0]?.share,
        firstAt: authors.contributors[0]?.firstAt,
      });
      expect(Object.keys(authors.contributors[0] ?? {})).not.toContain('series');
      // The same days are served to the reader themself, never to a visitor.
      expect(readMyTrace(fixture.db, seeded.identityId).series).toEqual([
        { day: '2026-10-24', edits: 1, chars: 10, share: 0.01 },
      ]);
      expect(authors.measuredAt).toBe('2026-10-24T12:00:00Z');
    } finally {
      fixture.close();
    }
  });
});

describe('the live byline count (BOOK-DOC-4)', () => {
  /** The byline and the list read one measurement: every contributor with surviving chars. */
  function listedWithChars(fixture: Fixture): number {
    return readAuthors(fixture.db, 'Филипп Семиров').contributors.filter((item) => item.chars > 0).length;
  }

  it('is 0 on the empty book — the line still reads «+ 0», never a dash', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      expect(countContributors(fixture.db)).toBe(0);
      expect(listedWithChars(fixture)).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('counts a reader with one surviving character, and the list agrees', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      releaseLease(fixture.db, seeded.leaseId);
      fixture.db
        .prepare(
          `INSERT INTO block_versions
             (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
              change_id, step_id, actor_kind, actor_label, identity_id, at)
           VALUES ('bkd_count', 1, 1, 1, 900, 'ch01#aa', 'h', 1, 'introduced', NULL, NULL,
                   'chg_1', 'stp_1', 'reader', 'Аня', ?, '2026-10-25T09:00:00Z')`,
        )
        .run(seeded.identityId);

      expect(countContributors(fixture.db)).toBe(1);
      expect(listedWithChars(fixture)).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('drops the reader from N and from the list when erosion wipes their last character', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);
      expect(countContributors(fixture.db)).toBe(1);

      // A later writer rewrites the chapter without the reader's paragraph.
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);

      expect(countContributors(fixture.db)).toBe(0);
      expect(listedWithChars(fixture)).toBe(0);
      // Erosion is not deletion: the edit stays recorded, but the public row is gone.
      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors).toEqual([]);
      expect(readMyTrace(fixture.db, seeded.identityId).edits).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('does not count a reader who hid from the list, and the list agrees', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);
      expect(countContributors(fixture.db)).toBe(1);

      fixture.db.prepare('UPDATE identities SET hide_from_authors = 1 WHERE id = ?').run(seeded.identityId);
      expect(countContributors(fixture.db)).toBe(0);
      expect(listedWithChars(fixture)).toBe(0);
      // The measurement is not hidden — only the name is.
      expect(readAuthors(fixture.db, 'Филипп Семиров').measured).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('marks every reading with a strictly increasing measuredAt', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      const frozen = new Date('2026-10-25T12:00:00.000Z');
      const read = createAuthorsCount(fixture.db, () => frozen);
      const first = read();
      const second = read();
      expect(first.count).toBe(0);
      expect(second.count).toBe(0);
      expect(Date.parse(second.measuredAt)).toBeGreaterThan(Date.parse(first.measuredAt));
    } finally {
      fixture.close();
    }
  });
});

describe('the reader’s own trace (BOOK-DOC-4)', () => {
  it('reports own label, edits, chars, share and the revisions the text survived', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);
      // One later author revision the reader's paragraph lived through.
      ingest(
        fixture,
        'ch01.md',
        `${AUTHOR_TEXT} Добавленный абзац номер два.\n\nТестовый абзац номер три. Это служебный текст, он не является текстом книги.`,
      );

      const trace = readMyTrace(fixture.db, seeded.identityId);
      expect(trace).toMatchObject({ label: 'Аня', edits: 1, hidden: false, survivedRevisions: 1, series: [] });
      expect(trace.chars).toBeGreaterThan(0);
      expect(trace.share).toBeGreaterThan(0);
      expect(trace.share).toBeLessThan(1);
      // Own only: no identity key anywhere in the payload (audit m3).
      expect(JSON.stringify(trace)).not.toContain(seeded.identityId);
    } finally {
      fixture.close();
    }
  });

  it('gives a reader with no trace the truthful zero, and never invents a name', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      const guest = upsertIdentity(fixture.db, {
        yandexSub: 'sub-guest',
        displayName: 'Гость',
        at: '2026-10-25T09:00:00Z',
      });
      expect(readMyTrace(fixture.db, guest.id)).toMatchObject({
        label: 'Гость',
        edits: 0,
        chars: 0,
        share: 0,
        hidden: false,
        survivedRevisions: 0,
        series: [],
      });

      fixture.db.prepare('UPDATE identities SET hide_from_authors = 1 WHERE id = ?').run(guest.id);
      expect(readMyTrace(fixture.db, guest.id).hidden).toBe(true);

      // An id the site does not know (a session whose identity vanished) is still no name.
      expect(readMyTrace(fixture.db, 'idt_unknown').label).toBe('читатель');
    } finally {
      fixture.close();
    }
  });

  it('gives a reader whose text was erased the truthful zero, not a modelled curve', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);
      expect(survivedRevisions(fixture.db, seeded.identityId)).toBe(0);

      ingest(fixture, 'ch01.md', AUTHOR_TEXT);

      const trace = readMyTrace(fixture.db, seeded.identityId);
      expect(trace.chars).toBe(0);
      expect(trace.share).toBe(0);
      expect(trace.survivedRevisions).toBe(0);
      expect(trace.edits).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('counts every later revision the surviving paragraph lived through', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, 'ch01.md', AUTHOR_TEXT);
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, 'ch01.md', `${AUTHOR_TEXT} Добавленный абзац номер два.`);
      releaseLease(fixture.db, seeded.leaseId);

      // Revisions that did not touch the reader's paragraph: they are what it survived.
      for (let rev = 3; rev <= 12; rev += 1) {
        fixture.db
          .prepare(
            `INSERT INTO revisions (chapter, rev, at, kind, cause_kind, added, changed, removed, snapshot, hseq)
             VALUES (1, ?, '2026-10-25T10:00:00Z', 'edit', 'operator', 0, 0, 0, 'versions/ch01/x.md', ?)`,
          )
          .run(rev, 900 + rev);
        fixture.db.prepare('UPDATE chapters SET rev = ? WHERE n = 1').run(rev);
      }
      expect(survivedRevisions(fixture.db, seeded.identityId)).toBe(10);
    } finally {
      fixture.close();
    }
  });
});

function contributor(overrides: Partial<AuthorContributorDto> = {}): AuthorContributorDto {
  return {
    identityId: 'idt_1',
    label: 'Аня',
    edits: 1,
    chars: 100,
    share: 0.1,
    firstAt: '2026-10-01T09:00:00Z',
    ...overrides,
  };
}

describe('the one order of the authors list (§6C.5 rule 6)', () => {
  it('orders by share first', () => {
    expect(compareContributors(contributor({ share: 0.2 }), contributor({ share: 0.1 }))).toBeLessThan(0);
    expect(compareContributors(contributor({ share: 0.1 }), contributor({ share: 0.2 }))).toBeGreaterThan(0);
    expect(compareContributors(contributor(), contributor())).toBe(0);
  });

  it('breaks a tie by the first change, and an unknown date sorts last', () => {
    const early = contributor({ firstAt: '2026-10-01T09:00:00Z' });
    const late = contributor({ firstAt: '2026-10-02T09:00:00Z' });
    expect(compareContributors(early, late)).toBeLessThan(0);
    expect(compareContributors(late, early)).toBeGreaterThan(0);

    const unknown = contributor({ firstAt: '' });
    expect(compareContributors(unknown, early)).toBe(1);
    expect(compareContributors(early, unknown)).toBe(-1);
  });

  it('breaks the remaining tie by label, then by identity', () => {
    expect(compareContributors(contributor({ label: 'Аня' }), contributor({ label: 'Борис' }))).toBeLessThan(0);
    expect(compareContributors(contributor({ label: 'Борис' }), contributor({ label: 'Аня' }))).toBeGreaterThan(0);
    expect(compareContributors(contributor({ identityId: 'a' }), contributor({ identityId: 'b' }))).toBeLessThan(0);
    expect(compareContributors(contributor({ identityId: 'b' }), contributor({ identityId: 'a' }))).toBeGreaterThan(0);
  });
});
