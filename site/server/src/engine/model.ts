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
 * Who ran the pass (owner, 2026-10-28). A **pipeline** pass is the writer lane on the pinned
 * model — ADR-038's check applies and is not weakened. An **operator** pass is a repair run by
 * a person: it may use any model the operator actually ran, because the rule is honesty about
 * who answered, not a relabelled pin — the record says `provenance: operator` and the model it
 * names is the model whose tokens the ledger charges.
 */
export type Provenance = 'pipeline' | 'operator';

export function normalizeProvenance(raw: unknown): Provenance {
  return raw === 'operator' ? 'operator' : 'pipeline';
}

/**
 * The canonical model string, or a refusal: `MODEL_REQUIRED` for nothing to check,
 * `MODEL_NOT_PIPELINE` for a model that is not the pinned one. Both are 422 and both carry
 * `where`, so the session loop can tell a close from a verdict without parsing a message.
 */
export function requirePipelineModel(
  config: Pick<Config, 'pipeline'>,
  declared: string | null | undefined,
  where: ModelWhere,
  provenance: Provenance = 'pipeline',
): string {
  const value = typeof declared === 'string' ? declared.trim() : '';
  if (value.length === 0) {
    refuse('MODEL_REQUIRED', 422, `a ${where} must declare --model: name the model that answered`, { where });
  }
  // An operator pass closes on the model it actually used; the pipeline check stays for the
  // pipeline's own passes (owner, 2026-10-28).
  if (provenance === 'operator') return value;
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
