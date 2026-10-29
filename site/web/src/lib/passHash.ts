import { TOTAL_CHAPTERS } from '@book/shared';

/**
 * An old `#проход-…` address, read as one of the two things it can still name.
 *
 * The pass record page is gone: a pass's change is the record's `правка` section (`?change=`),
 * and a bare pass — a landed stage with no change row — has no page at all, only the chapter it
 * was writing. Links written before the page was removed keep working through the same two
 * places; neither opens a surface of its own.
 */
export type PassHash =
  | { kind: 'change'; changeId: string }
  | { kind: 'chapter'; chapter: number };

export function passHashOf(hash: string, total: number = TOTAL_CHAPTERS): PassHash | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith('проход-')) return null;
  const rest = decoded.slice('проход-'.length);
  // `проход-<chapter>-<passId>`: a bare pass names its chapter, because the pass id alone
  // cannot be looked up by a reader's page.
  const bare = /^(\d{1,3})-([A-Za-z0-9_-]+)$/u.exec(rest);
  if (bare !== null) {
    const chapter = Number(bare[1]);
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > total) return null;
    return { kind: 'chapter', chapter };
  }
  // `проход-<changeId>`: a pass that carried a change, or a reader's change.
  if (rest.length === 0 || rest.length > 80 || !/^[A-Za-z0-9_-]+$/u.test(rest)) return null;
  return { kind: 'change', changeId: rest };
}
