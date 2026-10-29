/**
 * The pass's receipt, as rows (BOOK-187 AC7, ADR-043 §1: transcripts live in the DB).
 *
 * It used to be a JSON file per pass under `writer/transcripts/` — the prompt, the answer, the
 * canon, 7 MB of a second copy of the book in the data dir. Now one row per model call, and the
 * row is **facts only**:
 *
 * ```
 * { promptSha256, sections: [{ id, sha256, chars }], answer: { sha256, chars },
 *   verdict?: 'HOLDS' | 'GAP' | 'CLEAR' | 'REFUSED', failure?: '<CODE>' }
 * ```
 *
 * Nothing else can appear: this file never copies a message, a verdict's prose, a model id, an
 * endpoint, a session or a reader's words into a row — it hashes them and counts them. So a row is
 * useless as a second copy of the book even when it is read with the key in hand (the key is not
 * here either: it lives in the provider request and never in a fact).
 *
 * The hash is of the **exact bytes the model saw**: `sha256(system + "\n\n" + user)`, the same
 * concatenation `prompt.ts` hashes for a built prompt, so a draft row's `promptSha256` equals the
 * pass's `promptSha256` and a reader can prove which prompt produced which answer without ever
 * storing the prompt.
 */

import type { PipelineUsage } from './pipeline.ts';
import type { EngineClient } from './client.ts';
import { failureOf } from './reasons.ts';
import { sha256Hex } from '../util/hash.ts';

/** One model call of a pass, as the receipt records it. */
export type CallKind =
  | 'draft'
  | 'repair'
  | 'continue'
  | 'gate:editor'
  | 'gate:consultant'
  | 'gate:rights'
  | 'judge'
  /** BOOK-DOC-80: the local judge — a bounded question about the changed span, not a writing turn. */
  | 'tier1';

/**
 * BOOK-173 §4: the patch a pass applied, as the receipt counts it — how many edits, how many
 * characters, what fraction of the chapter, the facts the model claimed and the dangling skip.
 * Numbers and one short note; no prose.
 */
export type PatchReceipt = {
  edits: number;
  changedChars: number;
  fraction: number;
  facts: number;
  note: string | null;
  dangling: 'no-predecessor' | null;
};

/** The gate verdicts a row may name — the two prose enum values and Gate B's pair. */
export type CallVerdict = 'HOLDS' | 'GAP' | 'CLEAR' | 'REFUSED';

export type CallRecord = {
  kind: CallKind;
  /** Epoch ms of the call. */
  at: number;
  system: string;
  user: string;
  answer: string;
  usage: PipelineUsage;
  /**
   * BOOK-173 §5: the input the provider served from its cache, and the sha of the prefix the call
   * was sent under — so a row proves whether the cache-first layout hit, without storing a prompt.
   */
  cachedIn: number;
  prefixSha256: string;
  /** The parsed gate verdict, when the call was a gate and its answer parsed. */
  verdict?: CallVerdict;
};

/** One section of the prompt, as its own fact: an id, a hash, a length. */
export type PromptSectionFact = { id: string; sha256: string; chars: number };

/** The row the engine stores (`pass_transcripts`), before the sequence is assigned. */
export type TranscriptRow = {
  seq: number;
  at: number;
  role: CallKind;
  tokensIn: number;
  tokensOut: number;
  promptBundle: string | null;
  /** The redacted facts as JSON — the only free-form field of the row. */
  content: string;
};

export type TranscriptInput = {
  calls: readonly CallRecord[];
  /** The prompt's sections as the lane assembled them: ids, hashes and lengths only. */
  sections: readonly PromptSectionFact[];
  /** The bundle sha the pass ran under (ADR-043 G3), null when the image carried no stamp. */
  promptBundle: string | null;
  /** The pass's own failure code, when it ended in one — attached to the last row. */
  failure?: string | null;
  /**
   * BOOK-173 §5 / BOOK-DOC-80: the pass's own facts — the mode, the patch's counts, the gates
   * record and the prefix sha. Codes, numbers and hashes only, attached to the last row.
   */
  facts?: Record<string, unknown>;
};

/** A failure code is a machine word (`ANSWER_REFUSAL`), never a sentence. */
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/u;

/**
 * The same unit the book's own `chars` counts (`blocks.text.length`, `parseChapter`): a receipt's
 * length is comparable with a revision's without a reader having to know which unit was meant.
 */
function chars(value: string): number {
  return value.length;
}

/**
 * The rows of one pass, in call order. Empty when the pass never reached the model: a pass that
 * parked before its first call has no receipt to store, and its `refused` stage already says why.
 */
export function buildTranscriptRows(input: TranscriptInput): TranscriptRow[] {
  const sections = input.sections.map((section) => ({ id: section.id, sha256: section.sha256, chars: section.chars }));
  const failure = typeof input.failure === 'string' && CODE.test(input.failure) ? input.failure : null;
  return input.calls.map((call, index) => {
    const facts: Record<string, unknown> = {
      promptSha256: sha256Hex(`${call.system}\n\n${call.user}`),
      // BOOK-173 §5: the prefix the call was sent under, and how much of it the cache served.
      prefixSha256: call.prefixSha256,
      cachedIn: call.cachedIn,
      sections,
      answer: { sha256: sha256Hex(call.answer), chars: chars(call.answer) },
    };
    if (call.verdict !== undefined) facts.verdict = call.verdict;
    // The last row carries what the pass stopped on: one place, the row that ends the receipt.
    if (failure !== null && index === input.calls.length - 1) facts.failure = failure;
    // The pass's own record travels on its last row: one place ends the receipt.
    if (input.facts !== undefined && index === input.calls.length - 1) facts.pass = input.facts;
    return {
      seq: index + 1,
      at: call.at,
      role: call.kind,
      tokensIn: call.usage.in,
      tokensOut: call.usage.out,
      promptBundle: input.promptBundle,
      content: JSON.stringify(facts),
    };
  });
}

export type StoreTranscriptInput = TranscriptInput & {
  engine: EngineClient;
  log: (line: string) => void;
  passId: string;
};

/**
 * Send the receipt once, after the pass's outcome is known, and never let it change that outcome:
 * a receipt is evidence, and a step whose text landed must not park because the evidence did not.
 * A pass that never reached the model has no rows and no call.
 */
export async function storeTranscript(input: StoreTranscriptInput): Promise<void> {
  const rows = buildTranscriptRows(input);
  if (rows.length === 0) return;
  try {
    const stored = await input.engine.transcript({ passId: input.passId, rows });
    input.log(`[writer] транскрипт: ${String(stored.stored)} строк, удалено старых ${String(stored.pruned)}`);
  } catch (error) {
    input.log(`[writer] transcript not stored: ${failureOf(error).code ?? 'сбой'}`);
  }
}
