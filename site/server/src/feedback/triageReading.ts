/**
 * The `reading` block of a gate C answer (BOOK-206, ADR-045 §4) — the second half of a
 * `book.verdict/v1` object, parsed as **data** the way `gate.ts` parses the first half.
 *
 * The model says two things about one filing: whether it fits the canvas (`FITS`/`OFF`, the
 * gate's own question, unchanged) and **how it would be read** — one of the four rungs of the
 * ladder, with either its carrier (paper), its five refusal fields, or the finale lock. The
 * ladder itself lives in `disposition.ts` and is pure; this module is only the closed shape of
 * what a model may propose, because a proposal with a missing field would be decided by a guess.
 *
 * The rules are ADR-045 §4, table for table:
 *
 *   · `FITS` ⇒ `rung ∈ {as_said, through_paper}`; `OFF` ⇒ `rung ∈ {through_paper,
 *     refused_in_world, inadmissible}` — `OFF` + `as_said` is a contradiction, not a reading;
 *   · `through_paper` ⇒ a complete carrier (`kind` from the closed six, verbatim `quoteKept`,
 *     `factsChanged ≥ 1`), so the licence has no field it could be missing at decision time;
 *   · `refused_in_world` ⇒ all five refusal fields and `stamp` ≤ `STAMP_MAX_CHARS` (the line the
 *     reader is owed);
 *   · `inadmissible` ⇒ `lock = 'finale'` — the other three locks are facts the code holds;
 *   · `intent` on every rung: it becomes the change's one-goal sentence, and the engine runs
 *     `validateIntent` over it before anything is stored (the second injection guard).
 *
 * An answer that breaks a rule is a **failed call** — the writer reports it with
 * `/internal/triage/fail` and it is retried — never a guess and never a defaulted rung.
 */

import { CARRIER_KINDS, INTENT_MAX_CHARS, STAMP_MAX_CHARS, type CarrierKind } from '@book/shared';
import { parseVerdict, type AcceptedVerdict, type VerdictFailureCode, type VerdictResult } from './gate.ts';
import type { FilingEnvelope } from './envelope.ts';

export const READING_RUNGS = ['as_said', 'through_paper', 'refused_in_world', 'inadmissible'] as const;
export type ReadingRung = (typeof READING_RUNGS)[number];

export type ReadingCarrier = {
  kind: CarrierKind;
  /** The verbatim fragment the document promises to keep; the chooser re-checks it. */
  quoteKept: string;
  factsChanged: number;
};

export type ReadingRefusal = {
  establishedFact: string;
  namedPerson: string;
  namedInstance: string;
  cost: string;
  /** The refusing formula, in the chapter's own register; ≤ `STAMP_MAX_CHARS`. */
  stamp: string;
};

export type TriageReading = {
  rung: ReadingRung;
  /** Only `finale` may be proposed here; the other three locks are stored facts. */
  lock: 'finale' | null;
  /** The change's one-goal sentence; validated by the engine with the chapter's vocabulary. */
  intent: string;
  carrier: ReadingCarrier | null;
  refusal: ReadingRefusal | null;
};

/** The validated answer: gate C's own half plus the reading, and nothing else. */
export type TriageAnswer = AcceptedVerdict & { reading: TriageReading };

export type TriageFailureCode = VerdictFailureCode | 'READING_MALFORMED';

export type TriageFailure = { ok: false; code: TriageFailureCode; itemId: string | null; detail: string };

export type TriageParseResult = { ok: true; answer: TriageAnswer } | TriageFailure;

export type ReadingParseResult = { ok: true; reading: TriageReading } | TriageFailure;

const READING_KEYS = new Set(['rung', 'lock', 'intent', 'carrier', 'refusal']);
const CARRIER_KEYS = new Set(['kind', 'quoteKept', 'factsChanged']);
const REFUSAL_KEYS = new Set(['establishedFact', 'namedPerson', 'namedInstance', 'cost', 'stamp']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(detail: string, itemId: string | null = null): TriageFailure {
  return { ok: false, code: 'READING_MALFORMED', itemId, detail };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Every key of a closed block, or the first one that is not. */
function closedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const key of Object.keys(value)) if (!allowed.has(key)) return key;
  return null;
}

function carrierOf(raw: unknown): ReadingCarrier | null {
  if (!isRecord(raw)) return null;
  if (closedKeys(raw, CARRIER_KEYS) !== null) return null;
  const kind = typeof raw.kind === 'string' && CARRIER_KINDS.includes(raw.kind as CarrierKind) ? (raw.kind as CarrierKind) : null;
  const kept = text(raw.quoteKept);
  const facts = raw.factsChanged;
  if (kind === null || kept === null) return null;
  if (!Number.isInteger(facts) || (facts as number) < 1) return null;
  return { kind, quoteKept: kept, factsChanged: facts as number };
}

function refusalOf(raw: unknown): ReadingRefusal | null {
  if (!isRecord(raw)) return null;
  if (closedKeys(raw, REFUSAL_KEYS) !== null) return null;
  const establishedFact = text(raw.establishedFact);
  const namedPerson = text(raw.namedPerson);
  const namedInstance = text(raw.namedInstance);
  const cost = text(raw.cost);
  const stamp = text(raw.stamp);
  if (establishedFact === null || namedPerson === null || namedInstance === null || cost === null) return null;
  if (stamp === null || stamp.length > STAMP_MAX_CHARS) return null;
  return { establishedFact, namedPerson, namedInstance, cost, stamp };
}

/**
 * The `reading` block alone, against the verdict it accompanies. Public because the applier
 * re-reads a stored verdict and must apply the same edges — a row written by an older build is
 * not trusted merely because a build once accepted it.
 */
export function parseReadingBlock(
  raw: unknown,
  verdict: string,
): ReadingParseResult {
  if (!isRecord(raw)) return malformed('the answer carries no reading object');
  const unknownKey = closedKeys(raw, READING_KEYS);
  if (unknownKey !== null) return malformed(`unexpected reading key «${unknownKey}»`);
  // An absent rung on a `FITS` answer reads as `as_said` (ADR-045 §4): nothing has to be refused
  // when it fits. Every other case — and the intent — must be said outright.
  const rung = raw.rung ?? (verdict === 'FITS' ? 'as_said' : undefined);
  if (typeof rung !== 'string' || !READING_RUNGS.includes(rung as ReadingRung)) {
    return malformed(`reading rung ${String(rung)} is not one of ${READING_RUNGS.join('|')}`);
  }
  const intent = text(raw.intent);
  if (intent === null) return malformed('the reading carries no intent');
  if (intent.length > INTENT_MAX_CHARS) return malformed(`the intent is longer than ${INTENT_MAX_CHARS} characters`);

  if (verdict === 'FITS' && rung !== 'as_said' && rung !== 'through_paper') {
    return malformed(`FITS cannot be read as ${rung}`);
  }
  if (verdict === 'OFF' && rung === 'as_said') {
    return malformed('OFF cannot be read as said — the two contradict each other');
  }

  const lock = raw.lock ?? null;
  if (lock !== null && lock !== 'finale') return malformed(`reading lock ${String(lock)} is not a proposal`);
  if (rung === 'inadmissible' && lock !== 'finale') {
    return malformed('inadmissible needs lock «finale» — the other locks are facts, not proposals');
  }
  if (rung !== 'inadmissible' && lock !== null) {
    return malformed(`only an inadmissible reading may name a lock`);
  }

  // A carrier or a refusal that the rung does not use is dropped, never trusted: the rung is
  // what decides which licence runs, and a field it cannot use must not reach the chooser.
  const carrier = rung === 'through_paper' ? carrierOf(raw.carrier) : null;
  if (rung === 'through_paper' && carrier === null) return malformed('through_paper needs a complete carrier');
  const refusal = rung === 'refused_in_world' ? refusalOf(raw.refusal) : null;
  if (rung === 'refused_in_world' && refusal === null) {
    return malformed('refused_in_world needs all five refusal fields and a stamp of at most 120 characters');
  }

  return {
    ok: true,
    reading: { rung: rung as ReadingRung, lock: lock === 'finale' ? 'finale' : null, intent, carrier, refusal },
  };
}

/**
 * One gate C answer with its reading, against the envelope it was written from. The core keys
 * are `gate.ts`'s parser, untouched — the `reading` key is taken out before it runs (it is the
 * one key the gate's own closed set does not know) and validated here.
 */
export function parseTriageAnswer(raw: unknown, envelope: FilingEnvelope): TriageParseResult {
  if (!isRecord(raw)) return { ok: false, code: 'VERDICT_MALFORMED', itemId: null, detail: 'the answer is not one JSON object' };
  const { reading, ...core } = raw;
  const items = new Map([[envelope.itemId, envelope]]);
  const coreParsed: VerdictResult = parseVerdict(core, { gate: 'C', items });
  if (!coreParsed.ok) return coreParsed;
  const parsed = parseReadingBlock(reading, coreParsed.verdict.verdict);
  if (!parsed.ok) return parsed;
  return { ok: true, answer: { ...coreParsed.verdict, reading: parsed.reading } };
}
