/**
 * Types for `scripts/lib/position-boot.mjs` (BOOK-209) — the book a run is seeded from.
 *
 * Only the two decisions are declared, because only they are called by anything that type-checks:
 * which tree a run was told to import, and which volume it was told to copy. The rest of the
 * module spawns the build, the seed and the server, and no test drives it.
 */

/** The book tree `POSITION_BOOK_ROOT` names, or null; a named root without `manuscript/` throws. */
export function bookRoot(env?: Record<string, string | undefined>): string | null;

/** The seeded volume `POSITION_SEED_VOLUME` names, or null; a named volume without `book.db` throws. */
export function seedVolume(env?: Record<string, string | undefined>): string | null;
