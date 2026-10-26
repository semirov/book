import { describe, expect, it } from 'vitest';

import type { AuthorContributorDto } from '@book/shared';

import { compareContributors, readAuthors } from '../src/authors/contributions.ts';
import { publicAlias } from '../src/util/alias.ts';
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
      // Two readers whose text did not survive: equal shares, so the tie-break decides.
      const anya = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      releaseLease(fixture.db, anya.leaseId);
      const boris = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Борис' });
      releaseLease(fixture.db, boris.leaseId);
      fixture.db
        .prepare(`UPDATE changes SET enqueued_at = '2026-10-01T08:00:00Z' WHERE id = 'chg_2'`)
        .run();

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors.map((item) => item.label)).toEqual(['Борис', 'Аня']);
      expect(authors.contributors.map((item) => item.share)).toEqual([0, 0]);
      expect(authors.author.share).toBe(1);
      expect(authors.sum).toBeLessThanOrEqual(1);
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

  it('carries the erosion series with the share: a number without its curve is a score', () => {
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
      expect(authors.contributors[0]?.series).toEqual([
        { day: '2026-10-24', edits: 1, chars: 10, share: 0.01 },
      ]);
      expect(authors.measuredAt).toBe('2026-10-24T12:00:00Z');
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
    series: [],
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
