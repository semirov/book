import type {
  CatalogEntry,
  ChapterCreatedPayload,
  ChapterRevisionPayload,
  HelloPayload,
  StateSnapshot,
} from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  bookFromHello,
  catalogOutOfSync,
  loadedRevision,
  revisionFits,
  withAuthorsCount,
  withCatalogEntry,
  withChapterCreated,
  withChapterRevision,
  withFreshFront,
  withFront,
  withRevision,
  withState,
  type BookData,
} from './bookState.ts';

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: (n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4) as CatalogEntry['part'],
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 34 ? 'forward' : 'backward',
    ...overrides,
  };
}

const catalog = Array.from({ length: 67 }, (_, index) => entry(index + 1));

function state(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    version: 1,
    at: '',
    engine: { status: 'unknown', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: 'Название', about: 'О чём.', rev: 1, updatedAt: '' },
    chapters: { total: 67, written: [], empty: catalog.map((row) => row.n), count: 0, totalChars: 0, basis: [] },
    cursors: {} as StateSnapshot['cursors'],
    toc: catalog.map((row) => ({ part: row.part, n: row.n, title: row.title, written: row.written, rev: row.rev })),
    meeting: { forwardFront: null, backwardFront: null, gap: 67, converged: false, seam: 'not_reached' },
    cascade: null,
    queue: {
      depth: 0,
      byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
      head: null,
      processing: null,
      lastDecidedAt: null,
    },
    revising: [],
    current: null,
    unresolved: [],
    activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
    history: { live: false, readerChanges: 0, started: true },
    ...overrides,
  };
}

function data(overrides: Partial<BookData> = {}): BookData {
  const current = state();
  return {
    state: current,
    catalog,
    front: { title: 'Название', about: 'О чём.', rev: 1, toc: current.toc, imprint: { author: 'А', copyright: '© А' }, authors: { count: 2, measuredAt: '2026-10-25T12:00:00Z' } },
    ...overrides,
  };
}

const hello: HelloPayload = {
  connId: 'ws_1',
  protocolVersion: 3,
  serverTime: '',
  limits: {
    commentsPerHour: 10,
    maxCommentChars: 1200,
    maxEditChars: 10_000,
    queueSoftCap: 15,
    maxConnections: 100,
    perIp: 4,
    editSubmissionsPerDay: 1,
    maxWave: 5,
  },
  composer: { minChars: 3, maxChars: 1200, editMaxChars: 10_000 },
  viewer: { signedIn: false, displayName: null },
  front: { title: 'Название', about: 'О чём.', rev: 2, imprint: { author: 'А', copyright: '© А' }, authors: { count: 3, measuredAt: '2026-10-25T12:00:01Z' } },
  catalog: catalog.map((row) => (row.n === 1 ? { ...row, title: 'Начало', rev: 1, written: true } : row)),
  state: state({
    chapters: { total: 67, written: [1], empty: catalog.slice(1).map((row) => row.n), count: 1, totalChars: 10, basis: [] },
    toc: catalog.map((row) => (row.n === 1 ? { ...row, title: 'Начало', written: true, rev: 1 } : row)),
  }),
  currentChapter: null,
  comments: { open: 0 },
};

describe('bookFromHello', () => {
  it('paints the cover, page 2, the TOC and the catalog from one frame', () => {
    const book = bookFromHello(hello);
    expect(book.front).toMatchObject({ title: 'Название', about: 'О чём.', rev: 2 });
    expect(book.front.imprint.copyright).toBe('© А');
    // The byline count arrives with the first sheet, so page 1 never flashes «+ 0».
    expect(book.front.authors).toEqual({ count: 3, measuredAt: '2026-10-25T12:00:01Z' });
    expect(book.catalog).toHaveLength(67);
    expect(book.state.toc[0]).toMatchObject({ n: 1, title: 'Начало' });
  });

  it('heals the byline from hello but never lowers a newer live count', () => {
    const current = bookFromHello(hello);
    const newer = { ...current, front: { ...current.front, authors: { count: 5, measuredAt: '2026-10-25T12:05:00Z' } } };
    // A reconnect whose hello is older than the live page must not regress the number.
    expect(bookFromHello(hello, newer).front.authors).toEqual(newer.front.authors);
    // A hello measured later is the authority.
    const later = {
      ...hello,
      front: { ...hello.front, authors: { count: 7, measuredAt: '2026-10-25T12:06:00Z' } } as HelloPayload['front'],
    };
    expect(bookFromHello(later, newer).front.authors.count).toBe(7);
  });
});

describe('the edition number (BOOK-60)', () => {
  it('applies a fresh /api/front reading and leaves the book untouched without one', () => {
    const book = bookFromHello(hello);
    expect(withRevision(book, 42).front.revision).toBe(42);
    // An old payload is not a zero: the held number (or its absence) stands.
    expect(withRevision(book, undefined)).toBe(book);
    expect(withRevision(book, undefined).front.revision).toBeUndefined();
  });
});

describe('the live byline count', () => {
  it('applies a newer frame and ignores an older one, leaving the rest of the page alone', () => {
    const current = data();
    const next = withAuthorsCount(current, { count: 4, measuredAt: '2026-10-25T13:00:00Z' });
    expect(next.front.authors).toEqual({ count: 4, measuredAt: '2026-10-25T13:00:00Z' });
    expect(next.state).toBe(current.state);
    expect(next.catalog).toBe(current.catalog);

    const stale = withAuthorsCount(next, { count: 1, measuredAt: '2026-10-25T12:00:00Z' });
    expect(stale.front.authors).toEqual(next.front.authors);
    // A malformed frame is not a measurement.
    expect(withAuthorsCount(next, null).front.authors).toEqual(next.front.authors);
  });

  it('a REST resync keeps the newest byline reading instead of replacing it wholesale', () => {
    const held = withAuthorsCount(data(), { count: 5, measuredAt: '2026-10-25T12:05:00Z' });
    const stale = data();
    const merged = withFreshFront(stale, held);
    expect(merged.front.authors).toEqual(held.front.authors);
    expect(merged.state).toBe(stale.state);

    // A resync measured later is the authority, and a first paint has nothing to keep.
    const fresher = { ...stale, front: { ...stale.front, authors: { count: 7, measuredAt: '2026-10-25T12:06:00Z' } } };
    expect(withFreshFront(fresher, held).front.authors.count).toBe(7);
    expect(withFreshFront(fresher, null)).toBe(fresher);
  });
});

describe('state merges', () => {
  it('keeps the first sheet in step with the snapshot', () => {
    const next = withState(data(), state({ front: { title: 'Новое', about: 'Новое о чём.', rev: 3, updatedAt: '' } }));
    expect(next.front).toMatchObject({ title: 'Новое', about: 'Новое о чём.', rev: 3 });
  });

  it('ignores a snapshot older than the one it already holds (§7.2 rule 10)', () => {
    const current = data();
    expect(withState(current, state({ version: 0 }))).toBe(current);
    expect(withState(current, state({ version: 2 })).state.version).toBe(2);
  });

  it('carries the history fact through a state update (BOOK-56)', () => {
    const current = data();
    expect(current.state.history.live).toBe(false);
    const next = withState(current, state({ version: 2, history: { live: true, readerChanges: 1, started: true } }));
    expect(next.state.history).toEqual({ live: true, readerChanges: 1, started: true });
  });

  it('applies front:updated without touching the catalog', () => {
    const next = withFront(data(), {
      title: 'Тишина',
      about: 'Новая аннотация.',
      rev: 4,
      previousRev: 3,
      cause: { kind: 'draft', changeId: null, cascadeId: null, stepId: null },
    });
    expect(next.front.title).toBe('Тишина');
    expect(next.state.front.rev).toBe(4);
    expect(next.catalog).toBe(catalog);
  });

  it('refuses an older front revision', () => {
    const current = data();
    expect(
      withFront(current, {
        title: 'Старое',
        about: 'Старое.',
        rev: 0,
        previousRev: 0,
        cause: { kind: 'draft', changeId: null, cascadeId: null, stepId: null },
      }),
    ).toBe(current);
  });

  it('flags a catalog that disagrees with the snapshot TOC', () => {
    expect(catalogOutOfSync(state(), catalog)).toBe(false);
    const written = state({
      chapters: { total: 67, written: [1], empty: [], count: 1, totalChars: 10, basis: [] },
      toc: catalog.map((row) => (row.n === 1 ? { ...row, written: true, rev: 1, title: 'Глава' } : row)),
    });
    expect(catalogOutOfSync(written, catalog)).toBe(true);
    expect(catalogOutOfSync(written, withCatalogEntry(catalog, entry(1, { written: true, rev: 1, title: 'Глава' })))).toBe(false);
  });

  it('follows the basis flag of an unwritten slot (BOOK-6)', () => {
    const withBasis = withCatalogEntry(catalog, entry(1, { basis: true, blocks: 1, rev: 4 }));
    const basisState = state({
      chapters: { total: 67, written: [], empty: catalog.map((row) => row.n), count: 0, totalChars: 0, basis: [1] },
    });

    // Agreement: the slot is unwritten in both, and a former chapter's retained rev is not
    // a disagreement — only the basis flag is, because it changes what the reader sees.
    expect(catalogOutOfSync(basisState, withBasis)).toBe(false);
    // The frozen sentence appearing or disappearing must refresh the catalog.
    expect(catalogOutOfSync(basisState, catalog)).toBe(true);
    expect(catalogOutOfSync(state(), withBasis)).toBe(true);
    expect(catalogOutOfSync(state(), catalog)).toBe(false);
  });
});

describe('chapter events', () => {
  const created: ChapterCreatedPayload = {
    n: 2,
    title: 'Вторая',
    rev: 1,
    chars: 120,
    part: 1,
    direction: 'forward',
    cause: { kind: 'draft', lane: 'forward', leaseId: null, changeId: null, cascadeId: null, stepId: null },
    fetch: { path: '/api/chapters/2', etag: 'ch02-r1-b0' },
    createdAt: '2026-10-25T12:04:11Z',
    attributed: false,
  };

  it('inserts a created chapter into the catalog in order', () => {
    const next = withChapterCreated(data(), created);
    expect(next.catalog[1]).toMatchObject({ n: 2, title: 'Вторая', rev: 1, written: true, updatedAt: created.createdAt });
    expect(next.catalog).toHaveLength(67);
  });

  it('updates an existing row when a chapter is created over a previous failed load', () => {
    const withRow = data({ catalog: withCatalogEntry(catalog, entry(2, { written: false, rev: 0 })) });
    const next = withChapterCreated(withRow, created);
    expect(next.catalog.filter((row) => row.n === 2)).toHaveLength(1);
  });

  it('re-parses the title by applying the revision to the row that was already there', () => {
    const existing = data({ catalog: withCatalogEntry(catalog, entry(2, { written: true, rev: 1, title: 'Старая' })) });
    const revision: ChapterRevisionPayload = {
      n: 2,
      rev: 2,
      title: 'Новая',
      chars: 130,
      delta: 10,
      kind: 'edit',
      cause: {
        changeId: null,
        cascadeId: null,
        wave: null,
        lane: 'forward',
        direction: 'forward',
        stepId: null,
        seamsIn: [],
        seamsOut: [],
      },
      patch: [],
      patchTruncated: false,
      attributed: false,
      updatedAt: '2026-10-25T12:05:00Z',
    };
    const next = withChapterRevision(existing, revision);
    expect(next.catalog[1]).toMatchObject({ title: 'Новая', rev: 2, chars: 130 });
  });

  it('ignores a revision for a chapter the catalog does not know', () => {
    const book = data({ catalog: [] });
    expect(withChapterRevision(book, { ...created, rev: 2 } as unknown as ChapterRevisionPayload)).toBe(book);
  });

  it('turns a basis slot into a chapter when its first revision arrives (BOOK-6)', () => {
    const basis = data({ catalog: withCatalogEntry(catalog, entry(1, { basis: true, blocks: 1 })) });
    const revision: ChapterRevisionPayload = {
      n: 1,
      rev: 1,
      title: 'Начало',
      chars: 120,
      delta: 120,
      kind: 'create',
      cause: {
        changeId: null,
        cascadeId: null,
        wave: null,
        lane: 'forward',
        direction: 'forward',
        stepId: null,
        seamsIn: [],
        seamsOut: [],
      },
      patch: [],
      patchTruncated: false,
      attributed: false,
      updatedAt: '2026-10-25T12:05:00Z',
    };
    const next = withChapterRevision(basis, revision);
    expect(next.catalog[0]).toMatchObject({ n: 1, written: true, basis: false, rev: 1 });
  });
});

describe('revision rules', () => {
  it('applies a patch only at loadedRev + 1', () => {
    expect(revisionFits(2, 3)).toBe(true);
    expect(revisionFits(2, 4)).toBe(false);
    expect(revisionFits(0, 1)).toBe(true);
    expect(loadedRevision(withCatalogEntry(catalog, entry(8, { rev: 3 })), 8)).toBe(3);
    expect(loadedRevision(catalog, 8)).toBe(0);
  });
});
