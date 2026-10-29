/**
 * The lane's own text values: what an answer becomes when it lands, and what a prompt may quote
 * of an assignment. Pure — no engine, no clock, no file — so `pass.ts`, `answer.ts` and the
 * receipt all read one definition.
 *
 * It lives apart from `passLane.ts` because that file is at its arch bound; the lane re-exports
 * these, so a caller still imports from one place.
 */

import { type WriterAssignment } from '@book/shared';

import { normalizeChapterText, parseChapter } from '../ingest/parseChapter.ts';
import type { WriterAssignmentData } from './prompt.ts';
import { PassRefusal } from './reasons.ts';

function stripFence(value: string): string {
  const text = value.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/u.exec(text);
  return match?.[1] === undefined ? text : match[1].trim();
}

/** The prose of a continuation, with a repeated title line dropped and a stray fence stripped. */
export function mergeContinuation(chapter: number, written: string, raw: string): string {
  const addition = stripFence(normalizeChapterText(raw)).trim();
  if (addition.length === 0) return written;
  const title = parseChapter(chapter, written).title;
  const first = (addition.split('\n')[0] ?? '').trim();
  const body = title !== null && first === title ? addition.slice(first.length).trimStart() : addition;
  if (body.length === 0) return written;
  return `${written.trimEnd()}\n\n${body}`;
}

/** The bytes that land: the validated text, one trailing newline, nothing else touched. */
export function finalize(text: string): string {
  return `${text.trimEnd()}\n`;
}

export function charsOf(chapter: number, text: string): number {
  return parseChapter(chapter, text).chars;
}

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
