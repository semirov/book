/**
 * The dry run's plan (docs/writer-lane.md §5): what a pass *would* send, printed without a
 * lease, a model call or a byte written. It builds the real prompt from a synthetic assignment
 * so the shape a caller inspects is the shape a pass uses.
 */

import { CHAPTER_CHARS, TOTAL_CHAPTERS, isChapterNumber } from '@book/shared';

import { buildWriterPrompt, type BuiltPrompt, type WriterAssignmentData } from './prompt.ts';

/** The synthetic assignment a dry run prints: no engine, no lease, clearly marked `dryRun`. */
export type DryRunPlan = { dryRun: true; assignment: WriterAssignmentData; prompt: BuiltPrompt; summary: string };

export function dryRunPlan(input: { bookRoot: string; chapter: number }): DryRunPlan {
  if (!isChapterNumber(input.chapter)) {
    throw new Error(`главы ${String(input.chapter)} нет: глава — число от 1 до ${String(TOTAL_CHAPTERS)}`);
  }
  const assignment: WriterAssignmentData = {
    chapter: input.chapter,
    pass: 'draft',
    intent: { value: 'пробный прогон (dryRun): без модели, без записи', untrusted: true },
    interventionKind: null,
    premise: { intent: { value: 'пробный прогон (dryRun): замысел не читается', untrusted: true }, kind: null },
    expectation: { chars: { min: CHAPTER_CHARS.min, max: CHAPTER_CHARS.max } },
  };
  const prompt = buildWriterPrompt({ bookRoot: input.bookRoot, assignment });
  return {
    dryRun: true,
    assignment,
    prompt,
    summary: `глава ${String(input.chapter)}: ${String(prompt.sections.length)} разделов, ${String(prompt.system.length + prompt.user.length)} знаков`,
  };
}
