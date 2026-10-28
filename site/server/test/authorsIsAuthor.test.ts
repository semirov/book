import { describe, expect, it } from 'vitest';

import { floorShare } from '@book/shared';

import { readAuthors } from '../src/authors/contributions.ts';
import { countContributors } from '../src/authors/count.ts';
import { readMyTrace } from '../src/authors/trace.ts';
import { readContributors } from '../src/history/query.ts';
import { publicAlias } from '../src/util/alias.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { createFixture, type Fixture } from './helpers.ts';
import { releaseLease, seedChange } from './history/helpers.ts';
import { reconcile } from '../src/ingest/reconcile.ts';

/**
 * The author marker (owner, 2026-10-28): `identities.is_author`.
 *
 * The owner signs in and files like every reader, so his own identity was a contributor row and
 * the `+1` on the byline was him. The marker makes the imprint's author structural: he keeps his
 * trace, his edits and his filings, and loses only the second name — no contributor row, no
 * listed share, no `+N`. His characters do not disappear from the ledger; they fold into the
 * author's remainder, because the author *is* the remainder.
 */

const FRONT =
  'Без названия\n\n' +
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

const AUTHOR_TEXT =
  'Тестовая глава\n\n' +
  'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';

function ingest(fixture: Fixture, text: string): void {
  fixture.write('ch01.md', text);
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir, now: new Date('2026-10-25T09:00:00Z') });
}

/** One identity, marked as the imprint's author by the operator (the admin route's one write). */
function markAuthor(fixture: Fixture, identityId: string, hide = 0): void {
  fixture.db
    .prepare('UPDATE identities SET is_author = 1, hide_from_authors = ? WHERE id = ?')
    .run(hide, identityId);
}

describe('the author is not a contributor (owner, 2026-10-28)', () => {
  it('gives an author-only book one author, no rows, and his own characters', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, AUTHOR_TEXT);
      // The owner files through his reader identity: exactly the live shape behind «+ 1».
      const author = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Филипп Семиров' });
      markAuthor(fixture, author.identityId);
      ingest(fixture, `${AUTHOR_TEXT} Авторский абзац номер два.`);
      releaseLease(fixture.db, author.leaseId);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors).toEqual([]);
      expect(authors.sum).toBe(1);
      expect(authors.author.share).toBe(1);
      // The ledger keeps counting his edits: the author absorbs his own surviving characters.
      expect(authors.author.chars).toBe(authors.totalChars);
      expect(authors.author.chars).toBeGreaterThan(0);
      // `measured` counts measured identities before every filter, the author included.
      expect(authors.measured).toBe(1);
      // The byline: the author alone, no «+ 1» that is himself.
      expect(countContributors(fixture.db)).toBe(0);
      // He keeps his own trace: filings, edits and share are still his.
      const trace = readMyTrace(fixture.db, author.identityId);
      expect(trace.isAuthor).toBe(true);
      expect(trace.edits).toBe(1);
      expect(trace.chars).toBe(authors.totalChars);
    } finally {
      fixture.close();
    }
  });

  it('lists a second reader as the only contributor and counts «+ 1»', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, AUTHOR_TEXT);
      const author = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Филипп Семиров' });
      markAuthor(fixture, author.identityId);
      ingest(fixture, `${AUTHOR_TEXT} Авторский абзац номер два.`);
      releaseLease(fixture.db, author.leaseId);

      const anya = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Аня' });
      ingest(
        fixture,
        `${AUTHOR_TEXT} Авторский абзац номер два.\n\nАбзац Ани номер три. Это служебный текст, он не является текстом книги.`,
      );
      releaseLease(fixture.db, anya.leaseId);

      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(authors.contributors).toHaveLength(1);
      expect(authors.contributors[0]?.label).toBe('Аня');
      expect(authors.contributors.map((item) => item.label)).not.toContain('Филипп Семиров');
      // The shares still account for the whole book: the author takes the remainder.
      expect(authors.sum).toBe(1);
      expect(countContributors(fixture.db)).toBe(1);
      expect(authors.author.share).toBeLessThan(1);
      expect(authors.author.chars).toBe(authors.totalChars - (authors.contributors[0]?.chars ?? 0));
    } finally {
      fixture.close();
    }
  });

  it('moves the shares when the author rewrites a reader’s paragraph, without naming him', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, AUTHOR_TEXT);
      const anya = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(
        fixture,
        `${AUTHOR_TEXT} Абзац Ани номер два. Это служебный текст.\n\nАбзац Ани номер три. Это тоже служебный текст.`,
      );
      releaseLease(fixture.db, anya.leaseId);
      const before = readAuthors(fixture.db, 'Филипп Семиров');
      expect(before.contributors).toHaveLength(1);
      const anyaBefore = before.contributors[0]?.chars ?? 0;

      // The author's own filing rewrites one of her paragraphs and keeps the other.
      const author = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Филипп Семиров' });
      markAuthor(fixture, author.identityId);
      ingest(
        fixture,
        `${AUTHOR_TEXT} Абзац, переписанный автором. Это служебный текст.\n\nАбзац Ани номер три. Это тоже служебный текст.`,
      );
      releaseLease(fixture.db, author.leaseId);

      const after = readAuthors(fixture.db, 'Филипп Семиров');
      // One row only: her surviving trace shrank, and the author gained what she lost.
      expect(after.contributors).toHaveLength(1);
      expect(after.contributors[0]?.label).toBe('Аня');
      expect(after.contributors[0]?.chars).toBeLessThan(anyaBefore);
      expect(after.contributors[0]?.share).toBeLessThan(before.contributors[0]?.share ?? 1);
      expect(after.author.chars).toBeGreaterThan(before.author.chars);
      expect(after.author.chars).toBe(after.totalChars - (after.contributors[0]?.chars ?? 0));
      // Nothing about the ledger is hidden: the author's own edit is still recorded as his.
      expect(readMyTrace(fixture.db, author.identityId).edits).toBe(1);
      expect(readMyTrace(fixture.db, anya.identityId).edits).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('keeps the author out with either value of hide_from_authors, and a hidden reader out as before', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, AUTHOR_TEXT);
      const author = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Филипп Семиров' });
      markAuthor(fixture, author.identityId);
      ingest(fixture, `${AUTHOR_TEXT} Авторский абзац номер два.`);
      releaseLease(fixture.db, author.leaseId);
      const anya = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Аня' });
      ingest(
        fixture,
        `${AUTHOR_TEXT} Авторский абзац номер два.\n\nАбзац Ани номер три. Это служебный текст, он не является текстом книги.`,
      );
      releaseLease(fixture.db, anya.leaseId);
      expect(countContributors(fixture.db)).toBe(1);

      // The author is excluded by the marker, not by the opt-out: both flag values are the same.
      for (const hide of [1, 0]) {
        fixture.db.prepare('UPDATE identities SET hide_from_authors = ? WHERE id = ?').run(hide, author.identityId);
        const authors = readAuthors(fixture.db, 'Филипп Семиров');
        expect(authors.contributors.map((item) => item.label), `hide=${String(hide)}`).toEqual(['Аня']);
        expect(countContributors(fixture.db), `hide=${String(hide)}`).toBe(1);
      }

      // A reader's own opt-out still works exactly as before.
      fixture.db.prepare('UPDATE identities SET hide_from_authors = 1 WHERE id = ?').run(anya.identityId);
      const hidden = readAuthors(fixture.db, 'Филипп Семиров');
      expect(hidden.contributors).toEqual([]);
      expect(hidden.author.share).toBe(1);
      expect(countContributors(fixture.db)).toBe(0);
      // The measurement itself is not hidden.
      expect(hidden.measured).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it('keeps the author out of the chronicle’s contributor list as well, and its total intact', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, AUTHOR_TEXT);
      const author = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Филипп Семиров' });
      markAuthor(fixture, author.identityId);
      ingest(fixture, `${AUTHOR_TEXT} Авторский абзац номер два.`);
      releaseLease(fixture.db, author.leaseId);
      const anya = seedChange(fixture.db, { index: 2, chapter: 1, label: 'Аня' });
      ingest(
        fixture,
        `${AUTHOR_TEXT} Авторский абзац номер два.\n\nАбзац Ани номер три. Это служебный текст, он не является текстом книги.`,
      );
      releaseLease(fixture.db, anya.leaseId);

      // `/api/history/contributors` is this call: one public measurement, so it must agree with
      // `/api/authors` — the author is nobody's second name in either answer.
      const contributors = readContributors(fixture.db);
      const authors = readAuthors(fixture.db, 'Филипп Семиров');
      expect(contributors.items.map((item) => item.label)).toEqual(['Аня']);
      expect(contributors.items.map((item) => item.identityId)).not.toContain(
        publicAlias(author.identityId),
      );
      expect(JSON.stringify(contributors)).not.toContain(author.identityId);
      // The exclusion is a name, not a measurement: the book is still measured whole.
      expect(contributors.totalChars).toBe(authors.totalChars);
      expect(contributors.items[0]?.chars).toBe(authors.contributors[0]?.chars);
      // The chronicle prints the raw ratio while the end matter floors it: the same measurement,
      // two presentations (a pre-existing difference, not this marker's).
      expect(floorShare(contributors.items[0]?.share ?? 0)).toBe(authors.contributors[0]?.share);

      // A reader's own opt-out still works, exactly as before.
      fixture.db.prepare('UPDATE identities SET hide_from_authors = 1 WHERE id = ?').run(anya.identityId);
      expect(readContributors(fixture.db).items).toEqual([]);
      expect(readContributors(fixture.db).totalChars).toBe(contributors.totalChars);
    } finally {
      fixture.close();
    }
  });

  it('creates every new reader unmarked, and reads a missing identity as not the author', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      const reader = upsertIdentity(fixture.db, {
        yandexSub: 'sub-reader',
        displayName: 'Аня',
        at: '2026-10-25T09:00:00Z',
      });
      expect(reader.is_author).toBe(0);
      expect(readMyTrace(fixture.db, reader.id).isAuthor).toBe(false);
      expect(readMyTrace(fixture.db, 'idt_unknown').isAuthor).toBe(false);
    } finally {
      fixture.close();
    }
  });
});
