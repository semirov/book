/**
 * The SPA's book state reducer (ARCHITECTURE.md §10.4, §11.2): pure functions that merge
 * `hello`, `state:updated`, `chapter:*` and `front:updated` into the one page.
 *
 * Keeping this out of the component is what makes "two browsers stay consistent" and
 * "a reconnect re-syncs" testable without a DOM: `catalogOutOfSync` is the rule that
 * turns a `state:updated` written-set change (a removed or added file) into a catalog
 * refresh, and every chapter event is applied by `rev`, never by arrival order.
 */

import type {
  CatalogEntry,
  ChapterCreatedPayload,
  ChapterRevisionPayload,
  FrontDto,
  FrontUpdatedPayload,
  HelloPayload,
  StateSnapshot,
} from '@book/shared';

export type BookData = {
  state: StateSnapshot;
  catalog: CatalogEntry[];
  front: FrontDto;
};

export function bookFromHello(hello: HelloPayload): BookData {
  return {
    state: hello.state,
    catalog: hello.catalog,
    front: {
      title: hello.front.title,
      about: hello.front.about,
      rev: hello.front.rev,
      toc: hello.state.toc,
      imprint: hello.front.imprint,
    },
  };
}

export function withState(data: BookData, state: StateSnapshot): BookData {
  // §7.2 rule 10: a snapshot older than the one the client already holds is ignored.
  if (state.version < data.state.version) return data;
  return {
    ...data,
    state,
    // The snapshot is the authority for the TOC heading and the cover; `front` is only a
    // cache of the first sheet and must not contradict it.
    front: { ...data.front, title: state.front.title, about: state.front.about, rev: state.front.rev, toc: state.toc },
  };
}

export function withFront(data: BookData, front: FrontUpdatedPayload): BookData {
  if (front.rev < data.front.rev) return data;
  return {
    ...data,
    front: {
      ...data.front,
      title: front.title,
      about: front.about,
      rev: front.rev,
      toc: data.state.toc,
    },
    state: {
      ...data.state,
      front: {
        title: front.title,
        about: front.about,
        rev: front.rev,
        updatedAt: data.state.front.updatedAt,
      },
    },
  };
}

/** Insert or replace one catalog row, kept in numeric order. */
export function withCatalogEntry(catalog: readonly CatalogEntry[], entry: CatalogEntry): CatalogEntry[] {
  const next = catalog.filter((row) => row.n !== entry.n);
  next.push(entry);
  next.sort((left, right) => left.n - right.n);
  return next;
}

export function catalogEntryForChapter(catalog: readonly CatalogEntry[], n: number): CatalogEntry | null {
  return catalog.find((row) => row.n === n) ?? null;
}

function entryFromCreated(previous: CatalogEntry | null, created: ChapterCreatedPayload): CatalogEntry {
  return {
    n: created.n,
    part: created.part,
    title: created.title,
    rev: created.rev,
    chars: created.chars,
    blocks: previous?.blocks ?? 0,
    written: true,
    // A created chapter is prose: a basis-only slot is never announced as `chapter:created`.
    basis: false,
    writtenAt: previous?.writtenAt ?? created.createdAt,
    updatedAt: created.createdAt,
    direction: created.direction,
  };
}

export function withChapterCreated(data: BookData, created: ChapterCreatedPayload): BookData {
  const previous = catalogEntryForChapter(data.catalog, created.n);
  if (previous !== null && previous.rev > created.rev) return data;
  return { ...data, catalog: withCatalogEntry(data.catalog, entryFromCreated(previous, created)) };
}

function entryFromRevision(previous: CatalogEntry | null, revision: ChapterRevisionPayload): CatalogEntry | null {
  if (previous === null) return null;
  return {
    ...previous,
    title: revision.title,
    rev: revision.rev,
    chars: revision.chars,
    written: revision.rev > 0,
    // A revision means prose: a slot that was showing only its basis sentence is now a
    // chapter, and the frame paragraph no longer stands for it (BOOK-6).
    basis: false,
    updatedAt: revision.updatedAt,
  };
}

export function withChapterRevision(data: BookData, revision: ChapterRevisionPayload): BookData {
  const previous = catalogEntryForChapter(data.catalog, revision.n);
  if (previous !== null && revision.rev <= previous.rev) return data;
  const entry = entryFromRevision(previous, revision);
  return entry === null ? data : { ...data, catalog: withCatalogEntry(data.catalog, entry) };
}

/**
 * A `state:updated` whose TOC disagrees with the catalog means the catalog is stale.
 *
 * A basis slot (ch01/ch67) is unwritten in both, so `rev` and `title` only mean something
 * for a written row — a former chapter's retained `rev` is not a disagreement. Its `basis`
 * flag is one, though: gaining or losing the frozen sentence changes what the reader sees.
 */
export function catalogOutOfSync(state: StateSnapshot, catalog: readonly CatalogEntry[]): boolean {
  if (catalog.length !== state.toc.length) return true;
  const toc = new Map(state.toc.map((entry) => [entry.n, entry]));
  const basis = new Set(state.chapters.basis);
  return catalog.some((row) => {
    const entry = toc.get(row.n);
    if (entry === undefined || row.written !== entry.written) return true;
    if (basis.has(row.n) !== row.basis) return true;
    return row.written && (row.rev !== entry.rev || (row.title ?? null) !== (entry.title ?? null));
  });
}

/** The revision this client has loaded for a chapter; 0 when it has not loaded it. */
export function loadedRevision(catalog: readonly CatalogEntry[], n: number): number {
  return catalogEntryForChapter(catalog, n)?.rev ?? 0;
}

/** A chapter event is applied iff `rev === loadedRev + 1`; otherwise the client refetches. */
export function revisionFits(loadedRev: number, eventRev: number): boolean {
  return eventRev === loadedRev + 1;
}
