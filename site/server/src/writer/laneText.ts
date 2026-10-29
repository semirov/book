/**
 * The lane's own text values: the assignment a prompt may quote, and the text helpers `prose.ts`
 * owns (re-exported here so `pass.ts`, `answer.ts` and the receipt import one place).
 *
 * It lives apart from `passLane.ts` because that file is at its arch bound; the lane re-exports
 * these, so a caller still imports from one place.
 */

import { type WriterAssignment } from '@book/shared';

import type { WriterAssignmentData } from './prompt.ts';
import { PassRefusal } from './reasons.ts';

// One implementation lives in `prose.ts` (BOOK-173 §0); the lane re-exports it.
export { charsOf, finalize, mergeContinuation } from './prose.ts';

/** The assignment as the prompt may quote it (`prompt.ts` narrows it the same way). */
export function assignmentData(assignment: WriterAssignment): WriterAssignmentData {
  if (typeof assignment.chapter !== 'number') {
    throw new PassRefusal('этот проход не про главу — его ведёт другая полоса, а не писатель');
  }
  return {
    chapter: assignment.chapter,
    pass: assignment.pass,
    intent: assignment.intent,
    interventionKind: assignment.interventionKind,
    premise: assignment.premise === null ? null : { intent: assignment.premise.intent, kind: assignment.premise.kind },
    expectation: assignment.expectation,
  };
}
