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
 *
 * `pipeline-estimated` (BOOK-219) is still the pipeline: the pinned model ran, and the row is
 * **priced** (`priced = 1`) — the word says the numbers were read off the text (`provider.ts`'s
 * estimate) because the provider reported no usage, not that the pass was free or unpriced. A
 * call that spent its prompt and threw is charged the same way: a park after a paid request must
 * not read as zero.
 */
export type Provenance = 'pipeline' | 'operator' | 'pipeline-estimated';

export function normalizeProvenance(raw: unknown): Provenance {
  if (raw === 'operator') return 'operator';
  if (raw === 'pipeline-estimated') return 'pipeline-estimated';
  return 'pipeline';
}

/**
 * The step's own column keeps the two words it has always had — *who ran the pass*. The estimate
 * is a statement about the money, and the money's own record is `pass_spend.provenance`.
 */
export function stepProvenance(provenance: Provenance): 'pipeline' | 'operator' {
  return provenance === 'operator' ? 'operator' : 'pipeline';
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
