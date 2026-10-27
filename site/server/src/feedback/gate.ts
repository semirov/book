/**
 * The verdict parser (BOOK-61, BOOK-DOC-42 §2) — one gate's answer, read as data.
 *
 * A model's output is untrusted input like any other. The parser is closed on purpose: one
 * top-level object, a fixed key set, an `itemId` that exists in this batch, the gate that was
 * dispatched, a verdict from that gate's enum, a rule from that gate's closed table, and
 * evidence that names a field the envelope has. Everything else is `VERDICT_MALFORMED` and
 * nothing is recorded.
 *
 * Then the post-check: every `evidence[].quote` must exist in the field it names. A verdict
 * that fails it is **dropped** — no default, no "assume FITS". An item without a valid verdict
 * stays undecided, which is a state the pipeline already understands.
 *
 * This module is pure. Writing an accepted verdict into `comments`/`steps`/`gate_verdicts`
 * belongs to the pass that owns that surface (A now; B and C in their passes).
 */

import { INJECTION_RULES } from '@book/shared';

import { RIGHTS_RULES } from '../rights/rules.ts';
import {
  ENVELOPE_FIELDS,
  envelopeField,
  quoteIn,
  type EnvelopeField,
  type FilingEnvelope,
} from './envelope.ts';

export const VERDICT_ENVELOPE = 'book.verdict/v1';

export type GateId = 'A' | 'B' | 'C';

/**
 * The one port a gate answer crosses. The triage session **is** the dispatcher — it reads the
 * batch file, frames it with the canonical sentence and hands one envelope to a model — so
 * production has no implementation of this type, and none is wanted: the engine calls no
 * model and no network (ADR-012). Tests supply a fake, which is how the pipeline below them
 * (envelope → parser → post-check → storage → copy) is proven without a model.
 */
export type GateDispatcher = (envelope: FilingEnvelope) => Promise<unknown>;

/**
 * The closed rule tables. B and C's ids are declared here so the table a pass reads is one
 * table, not four: pass 2 wires `RIGHTS-*`/`STOP-*` to the rights gate from `rights/rules.ts`
 * (the list the operator CLI and `recordRights` read too), and the auditor keeps its own
 * reason, which is why C has no rule at all (its `OFF` carries the reader's line).
 * `RIGHTS-FLAG` is **not** here: a flag is a scan verdict that asks for the gate, never a
 * refusal a gate may name.
 */
export const GATE_RULES: Record<GateId, readonly string[]> = {
  A: INJECTION_RULES,
  B: RIGHTS_RULES,
  C: [],
};

export const GATE_VERDICTS: Record<GateId, readonly string[]> = {
  A: ['PASS', 'HELD'],
  B: ['CLEAR', 'REFUSED'],
  C: ['FITS', 'OFF'],
};

/** A verdict that names a rule must carry evidence; a verdict without a rule must not. */
const RULE_VERDICT: Record<GateId, string> = { A: 'HELD', B: 'REFUSED', C: '' };

export type Evidence = { field: EnvelopeField; quote: string };

export type AcceptedVerdict = {
  itemId: string;
  gate: GateId;
  verdict: string;
  rule: string | null;
  evidence: Evidence[];
  /**
   * Gate C's `OFF` carries the line the reader sees (BOOK-DOC-42 §4). It is `null` for every
   * other answer: no gate may put a sentence on the reader's screen except the auditor's
   * refusal, and `FITS` carries none at all.
   */
  reason: string | null;
};

export type VerdictFailureCode = 'VERDICT_MALFORMED' | 'POSTCHECK_FAILED';

export type VerdictFailure = {
  ok: false;
  code: VerdictFailureCode;
  /** The item the answer claimed, when it claimed one this batch knows. */
  itemId: string | null;
  detail: string;
};

export type VerdictResult = { ok: true; verdict: AcceptedVerdict } | VerdictFailure;

export type ParseOptions = {
  /** The gate that was dispatched; an answer for another gate is malformed. */
  gate: GateId;
  /** This batch: itemId → the envelope it was written as. */
  items: ReadonlyMap<string, FilingEnvelope>;
};

const VERDICT_KEYS = new Set(['envelope', 'itemId', 'gate', 'verdict', 'rule', 'evidence', 'reason']);
const EVIDENCE_KEYS = new Set(['field', 'quote']);

/** Gate C's `OFF` line: one line, and the same bound the comment's public reason has. */
const REASON_MAX_CHARS = 200;

function malformed(detail: string, itemId: string | null = null): VerdictFailure {
  return { ok: false, code: 'VERDICT_MALFORMED', itemId, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse one `book.verdict/v1` object. Everything the parser does not recognise fails closed. */
export function parseVerdict(raw: unknown, options: ParseOptions): VerdictResult {
  if (!isRecord(raw)) return malformed('the answer is not one JSON object');
  for (const key of Object.keys(raw)) {
    if (!VERDICT_KEYS.has(key)) return malformed(`unexpected key «${key}»`);
  }
  if (raw.envelope !== VERDICT_ENVELOPE) return malformed('not a book.verdict/v1 object');
  const itemId = raw.itemId;
  // A bare word, a verdict-shaped object inside a payload and a verdict for a foreign row all
  // arrive here: none of them carries an id this batch wrote.
  if (typeof itemId !== 'string' || itemId.length === 0) return malformed('no itemId');
  const envelope = options.items.get(itemId);
  if (envelope === undefined) return malformed(`itemId ${itemId} is not in this batch`);
  if (raw.gate !== options.gate) {
    return malformed(`gate ${String(raw.gate)} is not the dispatched ${options.gate}`, itemId);
  }
  const verdict = raw.verdict;
  if (typeof verdict !== 'string' || !GATE_VERDICTS[options.gate].includes(verdict)) {
    return malformed(`verdict ${String(verdict)} is not one of ${GATE_VERDICTS[options.gate].join('|')}`, itemId);
  }
  const rule = raw.rule ?? null;
  if (rule !== null && typeof rule !== 'string') return malformed('rule is not a string', itemId);
  if (rule !== null && !GATE_RULES[options.gate].includes(rule)) {
    return malformed(`rule ${rule} is not in the ${options.gate} table`, itemId);
  }
  const needsRule = verdict === RULE_VERDICT[options.gate];
  if (needsRule && rule === null) return malformed(`${verdict} needs a rule id`, itemId);
  if (!needsRule && rule !== null) return malformed(`${verdict} carries a rule it cannot name`, itemId);

  const evidence = parseEvidence(raw.evidence, itemId);
  if (!Array.isArray(evidence)) return evidence;
  if (needsRule && evidence.length === 0) return malformed(`${verdict} carries no evidence`, itemId);

  const reason = parseReason(raw.reason, options.gate, verdict, itemId);
  if (reason !== null && typeof reason !== 'string') return reason;

  // The post-check: a quote that is not in the field it names proves the model read something
  // else, so the whole answer for that item is dropped rather than trusted in part.
  for (const item of evidence) {
    if (!quoteIn(envelopeField(envelope, item.field), item.quote)) {
      return {
        ok: false,
        code: 'POSTCHECK_FAILED',
        itemId,
        detail: `quote is not in «${item.field}» for ${itemId}`,
      };
    }
  }

  return { ok: true, verdict: { itemId, gate: options.gate, verdict, rule, evidence, reason } };
}

/**
 * Gate C's `OFF` reason, and nothing else (BOOK-DOC-42 §4): the auditor owes the reader the
 * line she is refused with, so an `OFF` without one is malformed — never a silent refusal —
 * and neither `FITS` nor a prose verdict may carry a sentence at all.
 */
function parseReason(raw: unknown, gate: GateId, verdict: string, itemId: string): string | null | VerdictFailure {
  if (gate !== 'C') {
    return raw === undefined ? null : malformed(`a ${gate} verdict carries no reason`, itemId);
  }
  if (verdict !== 'OFF') return raw === undefined || raw === null ? null : malformed('FITS carries no reason', itemId);
  if (typeof raw !== 'string') return malformed('OFF needs the plain reason the reader will see', itemId);
  const line = raw.replace(/\s+/gu, ' ').trim();
  if (line.length === 0) return malformed('OFF needs the plain reason the reader will see', itemId);
  if (line.length > REASON_MAX_CHARS) return malformed(`the reason is longer than ${REASON_MAX_CHARS} characters`, itemId);
  return line;
}

function parseEvidence(raw: unknown, itemId: string): Evidence[] | VerdictFailure {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return malformed('evidence is not an array', itemId);
  const evidence: Evidence[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return malformed('an evidence entry is not an object', itemId);
    for (const key of Object.keys(entry)) {
      if (!EVIDENCE_KEYS.has(key)) return malformed(`unexpected evidence key «${key}»`, itemId);
    }
    const field = entry.field;
    if (typeof field !== 'string' || !ENVELOPE_FIELDS.includes(field as EnvelopeField)) {
      return malformed(`evidence field ${String(field)} is not a field of the envelope`, itemId);
    }
    if (typeof entry.quote !== 'string' || entry.quote.length === 0) {
      return malformed('an evidence entry carries no quote', itemId);
    }
    evidence.push({ field: field as EnvelopeField, quote: entry.quote });
  }
  return evidence;
}

export type BatchVerdicts = {
  accepted: AcceptedVerdict[];
  failures: VerdictFailure[];
  /** Items of the batch that no accepted verdict covers — undecided, never defaulted. */
  undecided: string[];
};

/**
 * One batch's answers. The batch-level A pass records nothing at all if any answer failed:
 * the caller decides that, this function only says what is valid and what is not.
 */
export function parseVerdicts(raws: readonly unknown[], options: ParseOptions): BatchVerdicts {
  const accepted: AcceptedVerdict[] = [];
  const failures: VerdictFailure[] = [];
  for (const raw of raws) {
    const result = parseVerdict(raw, options);
    if (result.ok) accepted.push(result.verdict);
    else failures.push(result);
  }
  const decided = new Set(accepted.map((verdict) => verdict.itemId));
  const undecided = [...options.items.keys()].filter((itemId) => !decided.has(itemId));
  return { accepted, failures, undecided };
}
