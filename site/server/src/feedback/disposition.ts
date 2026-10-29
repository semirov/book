/**
 * The chooser — the deterministic arbiter of how a filing is read (BOOK-174 comment #3888).
 *
 * The **semantic** reading comes from the triage decision line: a model says which of the four
 * answers the filing asks for. This module never invents one — and it never invents a place
 * either: the sentence a reading is recorded against is the filing's own ADR-044 anchor
 * (`comments.sentence_id`), and the two numbers the report prints come from the block and the
 * live sentence row. What it does is enforce the
 * ladder's order (`as_said` → `through_paper` → `refused_in_world` → `inadmissible`), the
 * licence of each rung, the four locks and the anti-cheat caps — so a decision line cannot buy a
 * refusal the book cannot back, and a filing that cannot be placed lands at the floor instead of
 * being thrown away or parked for a person.
 *
 * The rules, in the order they are applied:
 *
 *   1. **Locks first.** A rights refusal, the law (`guard === 'legal'` / `illegal-content`), a
 *      basis-only chapter (the frame is the whole text) or a decision that names the finale:
 *      `inadmissible` under that lock. These are the only refusals that exist.
 *   2. **The ladder over the proposal.** `as_said` holds when the filing carries one live
 *      sentence (ADR-044) and changes no repeated literal without a carrier. `through_paper`
 *      needs a carrier from the closed six, ≥5 words of the reader's own wording kept verbatim
 *      and ≥1 fact changed. `refused_in_world` needs the four facts of a real refusal and the
 *      caps' leave.
 *   3. **One rung up, never down to a bin — and the floor is `as_said`.** A failed carrier
 *      returns to `as_said`; a failed in-world refusal returns to `through_paper`, then
 *      `as_said`. The function is **total**: it never returns `escalated` (BOOK-206, ADR-045
 *      §5) — a filing whose quote does not resolve and whose carrier is not licensed still
 *      lands as `as_said` on its block anchor, because every stored filing has a place and no
 *      filing waits for a person.
 *
 * Pure: no database, no clock, no I/O. The storage side is `dispositionStore.ts`.
 */

import {
  CARRIER_KINDS,
  STAMP_MAX_CHARS,
  outcomeLine,
  normalizeCarrierKind,
  normalizeDisposition,
  normalizeDispositionLock,
  type CarrierKind,
  type Disposition,
  type DispositionLock,
} from '@book/shared';

export type DispositionProposal = {
  /** Absent means `as_said`: the gates already passed, so the words are taken as said. */
  disposition?: Disposition | null;
  carrierKind?: CarrierKind | null;
  /** The verbatim fragment the document promises to keep. */
  quoteKept?: string | null;
  /** How many facts the document changes. */
  factsChanged?: number;
  /** Rung 3: the fact or outcome the proposal contradicts. */
  establishedFact?: string | null;
  /** Rung 3: who proposes it on the page. */
  namedPerson?: string | null;
  /** Rung 3: who refuses (the instance). */
  namedInstance?: string | null;
  /** Rung 3: what the refusal costs. */
  cost?: string | null;
  /** Rung 3: the refusing formula, in the chapter's own register. */
  stamp?: string | null;
  /** Only `finale` may be named here: the other three locks are facts, not proposals. */
  lock?: DispositionLock | null;
};

export type DispositionCaps = {
  /** In-world refusals this reader already has in this chapter (the cap is one). */
  inWorldInChapterByReader: number;
  /** Is this stamp or formula already used in this chapter? */
  stampUsedInChapter: boolean;
  /** How many `refused_in_world` already stand in the chapter's trailing run. */
  runBefore: number;
};

/** The chain a decision leaves on the comment row: the five stored columns, and nothing else. */
export type DispositionDecision = {
  disposition: Disposition;
  lock: DispositionLock | null;
  carrierKind: CarrierKind | null;
  /** The one line the reader reads: the reading, or the lock's own sentence. */
  reason: string;
  quoteKept: string | null;
  /** The filing's own ADR-044 anchor (`snt_…`); null when it kept its block anchor. */
  sentenceId: string | null;
  blockIndex: number | null;
  sentenceIndex: number | null;
  /** The ambiguity form: `through_paper` named the plan it declined, because both existed. */
  alternate: boolean;
};

export type ChooseDispositionInput = {
  chapterIsBasis: boolean;
  chapter: number;
  blockText: string | null;
  /** The paragraph's stored idx, and the live sentence's idx — the two numbers the report prints. */
  blockIndex: number | null;
  sentenceIndex: number | null;
  /** ADR-044: the filing's own sentence id, or null when it kept its block anchor. */
  sentenceId: string | null;
  quote: string | null;
  body: string;
  proposedText: string | null;
  rightsVerdict: string | null;
  guard: string | null;
  flags: readonly string[];
  proposal: DispositionProposal;
  caps: DispositionCaps;
};

/** A reader's own wording: what they proposed, else what they wrote. */
export function filingWording(input: Pick<ChooseDispositionInput, 'body' | 'proposedText'>): string {
  return (input.proposedText ?? input.body).trim();
}

/**
 * BOOK-174 §7 — three in a row of `как отказ в мире` in one chapter is mockery, and the third
 * is the hard stop: it must be read as paper instead. The count is the run **before** this
 * decision, so one behind it is the last that may pass.
 */
export const MAX_IN_WORLD_RUN = 2;

/** A verbatim fragment shorter than this is not a document, it is a word. */
export const MIN_QUOTE_WORDS = 5;

/** Whitespace is the only thing normalised: «verbatim» means the letters are the same. */
function flatten(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The lock that applies to this filing, if any. A lock overrides every proposal. */
export function lockOf(
  input: Pick<ChooseDispositionInput, 'rightsVerdict' | 'guard' | 'flags' | 'chapterIsBasis' | 'proposal'>,
): DispositionLock | null {
  if (input.rightsVerdict === 'REFUSED') return 'rights';
  if (input.guard === 'legal' || input.flags.includes('illegal-content')) return 'harm';
  if (input.chapterIsBasis) return 'frame';
  // The one lock a decision may name: nothing else has a way to reach it.
  if (input.proposal.lock === 'finale') return 'finale';
  return null;
}

/**
 * The `as_said` criterion: one sentence to stand in, and nothing that already exists being
 * changed blind.
 *
 * The sentence is the filing's own ADR-044 anchor: `sentenceId` is what the posting path
 * resolved, so «exactly one sentence» is a stored fact rather than a second opinion about the
 * typography. A filing with no quote makes no sentence claim — there is nothing it could make
 * false — so it holds; a quote whose sentence did not resolve does not.
 */
export function asSaidHolds(input: ChooseDispositionInput, wording: string = filingWording(input)): boolean {
  const quote = input.quote === null ? '' : input.quote.trim();
  if (quote.length > 0 && input.blockText !== null && input.sentenceId === null) return false;
  return !repeatsLiteral(input, wording);
}

/**
 * Does the filing change a number or a date that already stands in the block? Without a carrier
 * that is a silent edit of an established fact — «120 дней» becoming «30 дней» is paper, not a
 * phrase — so it fails `as_said`.
 */
function repeatsLiteral(input: ChooseDispositionInput, wording: string): boolean {
  const carrier = input.proposal.carrierKind ?? null;
  if (carrier !== null) return false;
  const block = input.blockText;
  if (block === null) return false;
  const tokens = wording.match(/\d+/gu) ?? [];
  return tokens.some((token) => block.includes(token));
}

type Licence = { carrierKind: CarrierKind; quoteKept: string };

/** The `through_paper` licence: a carrier, ≥5 verbatim words, at least one fact changed. */
function carrierLicence(input: ChooseDispositionInput, wording: string): Licence | null {
  const carrier = input.proposal.carrierKind ?? null;
  if (carrier === null || !CARRIER_KINDS.includes(carrier)) return null;
  const kept = flatten(input.proposal.quoteKept ?? '');
  if (kept.length === 0) return null;
  // Verbatim after whitespace normalisation only: no case folding, no «ё» rewriting.
  if (!flatten(wording).includes(kept)) return null;
  if (kept.split(' ').length < MIN_QUOTE_WORDS) return null;
  const facts = input.proposal.factsChanged;
  if (typeof facts !== 'number' || !(facts >= 1)) return null;
  return { carrierKind: carrier, quoteKept: kept };
}

/**
 * Rung 3 is the one place the world may refuse, and it costs: a fact already established, a
 * person who proposes, an instance that answers, a price. The caps keep it from becoming a
 * template — one per reader per chapter, a stamp never twice in a chapter, and never a third
 * in a row.
 */
function inWorldHolds(input: ChooseDispositionInput): boolean {
  const proposal = input.proposal;
  const stamp = (proposal.stamp ?? '').trim();
  const complete =
    filled(proposal.establishedFact) &&
    filled(proposal.namedPerson) &&
    filled(proposal.namedInstance) &&
    filled(proposal.cost) &&
    // The stamp is what line 3 quotes: a refusal without its formula has nothing to print, and a
    // formula past `STAMP_MAX_CHARS` would not fit the line the reader is owed.
    filled(proposal.stamp) &&
    stamp.length <= STAMP_MAX_CHARS;
  if (!complete) return false;
  return (
    input.caps.inWorldInChapterByReader === 0 &&
    !input.caps.stampUsedInChapter &&
    input.caps.runBefore < MAX_IN_WORLD_RUN
  );
}

/**
 * The anchor a decision records: the filing's own sentence id and the two numbers the report
 * prints. Nothing is derived from the text here — ADR-044 resolved the sentence at posting time,
 * and a second opinion about where a quote sits is exactly the guess that decision forbids.
 */
function anchorOf(input: ChooseDispositionInput): {
  sentenceId: string | null;
  blockIndex: number | null;
  sentenceIndex: number | null;
} {
  return {
    sentenceId: input.sentenceId,
    blockIndex: input.blockIndex,
    sentenceIndex: input.sentenceId === null ? null : input.sentenceIndex,
  };
}

type Landing = {
  disposition: 'as_said' | 'through_paper' | 'refused_in_world';
  carrierKind: CarrierKind | null;
  quoteKept: string | null;
};

function landed(input: ChooseDispositionInput, landing: Landing, asSaidHeld: boolean): DispositionDecision {
  const anchor = anchorOf(input);
  return {
    disposition: landing.disposition,
    lock: null,
    carrierKind: landing.carrierKind,
    reason: outcomeLine({ kind: 'reading', reading: landing.disposition, carrierKind: landing.carrierKind }),
    quoteKept: landing.quoteKept,
    sentenceId: anchor.sentenceId,
    blockIndex: anchor.blockIndex,
    sentenceIndex: anchor.sentenceIndex,
    // The declined plan is named only when it really existed: the `as_said` rung held **and**
    // there was a sentence for it to stand in. A filing whose sentence never resolved had no such
    // plan — its words could not have been taken as said even if nothing else pushed back — and
    // naming it there would be decoration, not a choice.
    alternate: landing.disposition === 'through_paper' && asSaidHeld && anchor.sentenceId !== null,
  };
}

/** The four locks' one answer. Nothing landed, so no carrier and no anchor is carried. */
export function lockDecision(lock: DispositionLock): DispositionDecision {
  return {
    disposition: 'inadmissible',
    lock,
    carrierKind: null,
    reason: outcomeLine({ kind: 'lock', lock }),
    quoteKept: null,
    sentenceId: null,
    blockIndex: null,
    sentenceIndex: null,
    alternate: false,
  };
}

/**
 * The proposal a decision line carries, parsed from untrusted JSON: a word this build does not
 * know is dropped, never guessed at, and a numeric field must be a real integer.
 *
 * The line is the **only** source of the semantic reading (the chooser never invents one), so
 * this parser is deliberately lenient about what is absent and strict about what is present.
 */
export function parseDispositionProposal(raw: unknown): DispositionProposal | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string): string | null => {
    const field = value[key];
    return typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
  };
  const props: DispositionProposal = {
    disposition: normalizeDisposition(text('disposition')),
    carrierKind: normalizeCarrierKind(text('carrierKind')),
    quoteKept: text('quoteKept'),
    factsChanged: Number.isInteger(value.factsChanged) ? (value.factsChanged as number) : 0,
    establishedFact: text('establishedFact'),
    namedPerson: text('namedPerson'),
    namedInstance: text('namedInstance'),
    cost: text('cost'),
    stamp: text('stamp'),
    lock: normalizeDispositionLock(text('lock')),
  };
  return props;
}

/**
 * The one decision function: locks, then the ladder over the proposal, ending at the floor.
 *
 * A proposal may not refuse: `inadmissible` without a lock is read through the paper/said
 * ladder, and a word this build does not know is treated the same way. The ladder is **total**
 * (ADR-045 §5): its codomain is the three rungs plus the four locks, and the last rung is
 * `as_said` on the filing's own block anchor — the one answer every stored filing can be given.
 */
export function chooseDisposition(input: ChooseDispositionInput): DispositionDecision {
  const lock = lockOf(input);
  if (lock !== null) return lockDecision(lock);

  const wording = filingWording(input);
  const asSaid = asSaidHolds(input, wording);
  const licence = carrierLicence(input, wording);

  const asSaidOutcome = (): DispositionDecision =>
    landed(input, { disposition: 'as_said', carrierKind: null, quoteKept: null }, asSaid);
  const paperOutcome = (): DispositionDecision | null =>
    licence === null
      ? null
      : landed(
          input,
          { disposition: 'through_paper', carrierKind: licence.carrierKind, quoteKept: licence.quoteKept },
          asSaid,
        );
  /**
   * Rung 2, else the floor: a failed carrier never falls to a bin. The floor is `as_said` even
   * when `asSaidHolds` is false — a quote that resolved to no single sentence, or a standing
   * literal rewritten without a carrier, is still read as said against the block it was filed
   * on, and the reader is told how. There is no fifth state and no author's door (ADR-045 §5).
   */
  const oneRungUp = (): DispositionDecision => paperOutcome() ?? asSaidOutcome();

  switch (input.proposal.disposition ?? 'as_said') {
    case 'as_said':
      return asSaid ? asSaidOutcome() : oneRungUp();
    case 'refused_in_world':
      if (inWorldHolds(input)) {
        return landed(
          input,
          { disposition: 'refused_in_world', carrierKind: null, quoteKept: (input.proposal.stamp ?? '').trim() },
          asSaid,
        );
      }
      // One rung up: the paper it could be, then the words as said — the floor.
      return oneRungUp();
    case 'through_paper':
    case 'inadmissible':
    default:
      // Anything else — the removed fifth state, a word this build does not know — is not a
      // proposal: the ladder reads it one rung up, exactly as it reads a paper it cannot licence.
      return oneRungUp();
  }
}
