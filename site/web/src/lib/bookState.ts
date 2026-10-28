/**
 * The SPA's book state reducer (ARCHITECTURE.md §10.4, §11.2): pure functions that merge
 * `hello`, `state:updated`, `chapter:*` and `front:updated` into the one page.
 *
 * Keeping this out of the component is what makes "two browsers stay consistent" and
 * "a reconnect re-syncs" testable without a DOM: `catalogOutOfSync` is the rule that
 * turns a `state:updated` written-set change (a removed or added file) into a catalog
 * refresh, and every chapter event is applied by `rev`, never by arrival order.
 */

import { openingOf, type CatalogEntry, type ChapterCreatedPayload, type ChapterRevisionPayload, type FrontDto, type FrontUpdatedPayload, type HelloPayload, type PatchOp, type StateSnapshot } from '@book/shared';

import { newestAuthorsCount } from './authorsCount.ts';

export type BookData = {
  state: StateSnapshot;
  catalog: CatalogEntry[];
  front: FrontDto;
};

export function bookFromHello(hello: HelloPayload, held: BookData | null = null): BookData {
  return {
    state: hello.state,
    catalog: hello.catalog,
    front: {
      title: hello.front.title,
      about: hello.front.about,
      rev: hello.front.rev,
      toc: hello.state.toc,
      imprint: hello.front.imprint,
      // A reconnect heals the byline from `hello`, but never lowers a newer live count.
      authors: newestAuthorsCount(held?.front.authors, hello.front.authors),
      // BOOK-126: the gift link is config, not live data — a frame without it (an older hello,
      // a resync that predates the field) must keep what the page already has instead of
      // switching the row off and back on.
      donateUrl: hello.front.donateUrl ?? held?.front.donateUrl ?? null,
      // BOOK-60: `hello` carries no edition number; a reconnect keeps the page's, and the
      // next text frame re-reads it from `/api/front`. BOOK-138: the size belongs to that
      // edition, so the two are kept together — a number without its file size would print the
      // verb alone on a page that already knows how big the file is.
      revision: held?.front.revision,
      ...(held?.front.exportBytes === undefined ? {} : { exportBytes: held.front.exportBytes }),
    },
  };
}

/**
 * The byline count is live and monotonic (BOOK-DOC-4): `measuredAt` orders two readings, so
 * an out-of-order frame never lowers N. Page 1, the socket and the hide response all pass
 * through here, and a reconnect's `hello` already carries the count in `front`.
 */
export function withAuthorsCount(data: BookData, count: unknown): BookData {
  return {
    ...data,
    front: { ...data.front, authors: newestAuthorsCount(data.front.authors, count) },
  };
}

/**
 * BOOK-60 / BOOK-138: the edition number and the export's size from a fresh `/api/front`
 * reading. A REST resync that must not overwrite a newer `hello` still contributes these two
 * facts; an old payload without the fields leaves what the page already has.
 *
 * The two are written together because one answer produced both: a reader who is told the new
 * edition must not be told the old file's size, and the size is not monotonic — a shorter
 * edition is a smaller file — so it cannot carry a guard of its own. It moves exactly when the
 * revision moves.
 *
 * When the number moves and the payload carries no size, the held size is **dropped**: it
 * describes the previous edition's file. An asset kept for a year can talk to an older server
 * after a rollback, and that server sends the number without the size — printing the size the
 * page already had would state a length the new file does not have. The verb alone is the
 * honest label. The held size is kept only when the revision is unchanged (the same edition's
 * answer, or one that does not mention a size), and an unusable value (NaN) is treated as
 * absent.
 */
export function withRevision(data: BookData, revision: number | undefined, exportBytes?: number): BookData {
  if (typeof revision !== 'number') return data;
  const size = typeof exportBytes === 'number' && Number.isFinite(exportBytes) ? exportBytes : undefined;
  const front: FrontDto = { ...data.front, revision };
  if (size !== undefined) {
    front.exportBytes = size;
  } else if (front.revision !== data.front.revision) {
    // No size for a new edition: the held one belongs to the file this page no longer names.
    delete front.exportBytes;
  }
  return { ...data, front };
}

/**
 * A REST resync replaces the cover, page 2 and the catalog, but it must not undo a live
 * byline reading that arrived first: the two go through the same monotonic guard, so a
 * resync can raise N and never lower it.
 */
export function withFreshFront(next: BookData, held: BookData | null): BookData {
  if (held === null) return next;
  return {
    ...next,
    front: {
      ...next.front,
      authors: newestAuthorsCount(held.front.authors, next.front.authors),
      // BOOK-126: the resync replaces `front` wholesale; the gift link is config and must hold
      // when the payload does not carry it, so the footer row never flickers off and on.
      donateUrl: next.front.donateUrl ?? held.front.donateUrl ?? null,
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
    opening: null,
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

/**
 * The contents' excerpt after a live revision (owner, 2026-10-28): the patch carries the new
 * first block when it touched it, the previous excerpt stands when the first block was left
 * alone, and a first block that was removed leaves nothing to trust until the next catalog read
 * — a stale sentence is not that chapter's opening any more.
 */
function openingAfter(previous: string | null, patch: readonly PatchOp[]): string | null {
  const first = patch.find((op) => op.op !== 'remove' && op.i === 0 && op.text !== undefined);
  if (first?.text !== undefined) return openingOf(first.text);
  if (patch.some((op) => op.op === 'remove' && op.i === 0)) return null;
  return previous;
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
    opening: openingAfter(previous.opening ?? null, revision.patch),
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
