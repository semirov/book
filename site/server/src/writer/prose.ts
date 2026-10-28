/**
 * The prose arithmetic of one writing turn (BOOK-117 §1–2, moved here by BOOK-173 §0 so the
 * pass and the lane stay under the 500-line wall).
 *
 * Three pure helpers, no I/O: what a continuation's text becomes, what the written bytes are,
 * and what the chapter counts — all read through `parseChapter`, never through a second
 * paragraph rule.
 */

import { CHAPTER_CHARS } from '@book/shared';

import { normalizeChapterText, parseChapter } from '../ingest/parseChapter.ts';

/** One surrounding fence is stripped; a stray one is not a chapter either way. */
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

/** A chapter under the thin line takes another continuation call, never a second chapter. */
export function isThin(chapter: number, text: string): boolean {
  return charsOf(chapter, text) < CHAPTER_CHARS.min;
}
