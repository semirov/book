/**
 * The model refusal (ADR-038, BOOK-62).
 *
 * The engine stores a model on every step and on every gate verdict. Until BOOK-62 a missing
 * one became the string `'stub'` in two places, which made «prod is Pro» unverifiable — a
 * silent default is exactly how a pipeline drifts off its pin. So the engine now **refuses** a
 * close or a verdict that declares nothing, or declares any model but the configured one, and
 * says which of the two it is.
 *
 * Presence is enforced here rather than in the HTTP schema on purpose: the CLI, the internal
 * API and a direct caller then refuse with the same code (`MODEL_REQUIRED`), and a caller that
 * only speaks JSON still gets a stable `code` to branch on.
 *
 * The honest limit, stated once: this validates the *declared* string. What makes the claim
 * checkable is the record — `steps.model`, `gate_verdicts.model`, the token counts, and, for
 * the model lane, the provider's own `response.model` in the transcript.
 */

import type { Config } from '../config.ts';
import { refuse } from './types.ts';

/** Where the declaration came from. The CLI prints it; the log line is the same either way. */
export type ModelWhere = 'done' | 'seen' | 'verdict';

/**
 * The canonical model string, or a refusal: `MODEL_REQUIRED` for nothing to check,
 * `MODEL_NOT_PIPELINE` for a model that is not the pinned one. Both are 422 and both carry
 * `where`, so the session loop can tell a close from a verdict without parsing a message.
 */
export function requirePipelineModel(
  config: Pick<Config, 'pipeline'>,
  declared: string | null | undefined,
  where: ModelWhere,
): string {
  const value = typeof declared === 'string' ? declared.trim() : '';
  if (value.length === 0) {
    refuse('MODEL_REQUIRED', 422, `a ${where} must declare --model: name the model that answered`, { where });
  }
  const expected = config.pipeline.model;
  if (value !== expected) {
    refuse('MODEL_NOT_PIPELINE', 422, `the ${where} declares "${value}"; the pipeline runs on "${expected}"`, {
      declared: value,
      expected,
      where,
    });
  }
  return expected;
}
