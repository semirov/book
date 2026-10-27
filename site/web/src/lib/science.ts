/**
 * BOOK-76 / BOOK-DOC-52 §3, §5.2 — the change record's one line about the physics pass.
 *
 * The DTO carries the verdict as one word (`ChangeDto.scienceCheck`) and deliberately no
 * role name: the payload carries the fact, this module carries the word a reader sees. The
 * name may appear here and in `/rules`; the file-set guard (`server/test/copy.test.ts`)
 * keeps it from spreading to any other surface.
 */

import type { ChangeDto } from '@book/shared';

export type ScienceCheck = NonNullable<ChangeDto['scienceCheck']>;

/** The role the reader is told about — the third question, the second prose gate. */
export const SCIENCE_ROLE = 'научный консультант';

/**
 * The value of the card's `проверка` pair, or `null` when no pass has answered. A change
 * whose step is unwritten or unread says nothing: no line without data.
 */
export function scienceLine(check: ScienceCheck | null): string | null {
  if (check === 'passed') return `пройдена · ${SCIENCE_ROLE}`;
  if (check === 'failed') return `не пройдена · ${SCIENCE_ROLE}`;
  return null;
}
