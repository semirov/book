/**
 * The filing envelope (BOOK-61, BOOK-DOC-42 §2).
 *
 * A batch stays a file (ADR-007), but one line of it is no longer a raw item: it is
 * `book.filing/v1`, and every value a stranger wrote sits under `untrusted: true`. `itemId`
 * stays **outside** every untrusted subtree, so a model that answers with a verdict names an
 * id the container vouches for — never a string it read inside the payload.
 *
 * The batch is one fence line, the envelopes, the same fence line. The fence is the batch id
 * minted at creation: a reader cannot know it before her row exists, and a value that carries
 * another batch's fence is held (`INJ-FENCE`) by the filter, not by this module.
 *
 * This module is pure: no database, no file, no model. `batches.ts` writes the file,
 * `gate.ts` reads the answer.
 */

import { FRAMING_SENTENCE, fenceLine, foldForMatch } from '@book/shared';
import type { Untrusted } from '@book/shared';

import { spaceInvisible } from '../comments/sanitize.ts';

export const FILING_ENVELOPE = 'book.filing/v1';

/**
 * The canonical framing sentence, re-exported so the three gates import one string from one
 * place (BOOK-DOC-42 §2). It is defined in `@book/shared` because the pre-filter detects a copy
 * of it (`INJ-FRAME`) and shared must not reach into the server.
 */
export { FRAMING_SENTENCE, fenceLine };

/** The four fields a stranger writes. A verdict may quote one of them and nothing else. */
export type EnvelopeField = 'author' | 'quote' | 'text' | 'proposed' | 'world';

/**
 * BOOK-206 (ADR-045 §4): `world` is the fifth field a verdict may quote — the anchor block and
 * its two neighbours **as the server read them from rows**. It is trusted (no stranger typed it),
 * so it lives beside the four rather than inside the `untrusted` mark: «does this fit this
 * world» cannot be grounded in the filing alone, and a quote from it is post-checked like any
 * other (the server's own text is what makes the check meaningful).
 */
export const ENVELOPE_FIELDS: readonly EnvelopeField[] = ['author', 'quote', 'text', 'proposed', 'world'];

/** Every untrusted value travels with its own mark, so a nested read cannot lose it. */
export type UntrustedValue = Untrusted<string | null>;

/**
 * A value the **server** built (`world`): it travels in the same shape, so one reader answers
 * every field, and its mark says so — `untrusted: false` is the one thing a stranger's value can
 * never carry, because a batch line's `world` is dropped when it is read back (`asEnvelope`).
 */
export type TrustedValue = { value: string | null; untrusted: false };

export type FilingEnvelope = {
  envelope: typeof FILING_ENVELOPE;
  itemId: string;
  chapter: number;
  block: string | null;
  rev: number;
  kind: string | null;
  author: UntrustedValue;
  quote: UntrustedValue;
  text: UntrustedValue;
  proposed: UntrustedValue;
  /** The anchor block and its neighbours, from rows; null when no world was attached. */
  world: TrustedValue;
};

/** The normalised values of one filing, before they are wrapped in the envelope. */
export type FilingValues = {
  author: string;
  quote: string | null;
  text: string;
  proposed: string | null;
};

function untrusted(value: string | null): UntrustedValue {
  return { value, untrusted: true };
}

function trusted(value: string | null): TrustedValue {
  return { value, untrusted: false };
}

/**
 * One envelope for one filing. `kind` is the intervention's own claim, an id from a closed
 * list, and `block`/`rev` come from the server: none of them is free text.
 */
export function buildEnvelope(item: {
  id: string;
  chapter: number;
  block: string | null;
  rev: number;
  kind: string | null;
  values: FilingValues;
}): FilingEnvelope {
  return {
    envelope: FILING_ENVELOPE,
    itemId: item.id,
    chapter: item.chapter,
    block: item.block,
    rev: item.rev,
    kind: item.kind,
    author: untrusted(item.values.author),
    quote: untrusted(item.values.quote),
    text: untrusted(item.values.text),
    proposed: untrusted(item.values.proposed),
    world: trusted(null),
  };
}

/**
 * The same envelope with the world attached (BOOK-206). `world` is the server's own reading of
 * the anchor block and its neighbours from rows, so it travels in the fence's shape without the
 * stranger's mark: it is the book the filing is judged against, never a value anyone submitted.
 */
export function withWorld(envelope: FilingEnvelope, world: string | null): FilingEnvelope {
  return { ...envelope, world: trusted(world) };
}

/** The value of one envelope field; `null` when the filing has none. */
export function envelopeField(envelope: FilingEnvelope, field: EnvelopeField): string | null {
  return envelope[field].value;
}

/** `JSON.stringify` escapes a newline and a fence alike: an envelope is always one line. */
export function envelopeLine(envelope: FilingEnvelope): string {
  return JSON.stringify(envelope);
}

/** The whole batch file: fence, one envelope per line, the same fence. */
export function fencedBody(batchId: string, envelopes: readonly FilingEnvelope[]): string {
  const fence = fenceLine(batchId);
  return `${[fence, ...envelopes.map(envelopeLine), fence].join('\n')}\n`;
}

export type ParsedBatch =
  | { ok: true; envelopes: FilingEnvelope[] }
  | { ok: false; error: string };

/** A line that opens a `<<<DATA …>>>` fence, whatever id it carries. */
const FENCE_PREFIX = /^<<<\s*data\b/iu;

/**
 * Read a batch file back. The fence must be the batch's own, and both ends must be present:
 * a file whose fence was closed early is not silently read as more data. Fail closed.
 *
 * A batch written before v14 has no fence and holds one raw item per line (BOOK-61 review B3):
 * it is read as its items, each wrapped in an envelope on the fly, so `feedback.mjs read` and
 * `--answer` keep working on an exchange directory that outlived the deploy. A file that opens
 * a fence with an id that is not this batch's is a tamper signal, not a legacy file.
 */
export function parseBatchFile(text: string, batchId: string): ParsedBatch {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const fence = fenceLine(batchId);
  if (lines.length === 0) return { ok: false, error: `batch ${batchId} is empty` };

  if (lines[0] === fence && lines[lines.length - 1] === fence && lines.length >= 2) {
    const envelopes: FilingEnvelope[] = [];
    for (const line of lines.slice(1, -1)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return { ok: false, error: `batch ${batchId} carries a line that is not JSON` };
      }
      const envelope = asEnvelope(parsed);
      if (envelope === null || envelope.itemId.length === 0) {
        return { ok: false, error: `batch ${batchId} carries a line that is not a ${FILING_ENVELOPE} envelope` };
      }
      envelopes.push(envelope);
    }
    return { ok: true, envelopes };
  }

  if (FENCE_PREFIX.test(lines[0] ?? '') || FENCE_PREFIX.test(lines[lines.length - 1] ?? '')) {
    return { ok: false, error: `batch ${batchId} is not enclosed by its fence` };
  }
  return legacyBatch(lines, batchId);
}

/** The pre-v14 file: one raw item per line, no fence. Each line becomes an envelope as it was. */
function legacyBatch(lines: readonly string[], batchId: string): ParsedBatch {
  const envelopes: FilingEnvelope[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return { ok: false, error: `batch ${batchId} carries a line that is not JSON` };
    }
    const envelope = legacyEnvelope(parsed);
    if (envelope === null) {
      return {
        ok: false,
        error: `batch ${batchId} carries a line that is neither an envelope nor a pre-v14 item`,
      };
    }
    envelopes.push(envelope);
  }
  return { ok: true, envelopes };
}

/** One pre-v14 item (`{id, chapter, block, rev, quote, text, proposed, kind, author, …}`). */
function legacyEnvelope(value: unknown): FilingEnvelope | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.chapter !== 'number' || typeof record.text !== 'string') {
    return null;
  }
  return buildEnvelope({
    id: record.id,
    chapter: record.chapter,
    block: typeof record.block === 'string' ? record.block : null,
    rev: typeof record.rev === 'number' ? record.rev : 0,
    kind: typeof record.kind === 'string' ? record.kind : null,
    values: {
      author: typeof record.author === 'string' ? record.author : '',
      quote: typeof record.quote === 'string' ? record.quote : null,
      text: record.text,
      proposed: typeof record.proposed === 'string' ? record.proposed : null,
    },
  });
}

/** The parts of a parsed line this build knows how to read; anything else is not an envelope. */
function asEnvelope(value: unknown): FilingEnvelope | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.envelope !== FILING_ENVELOPE) return null;
  if (typeof record.itemId !== 'string') return null;
  // `chapter` and `rev` are the server's own numbers; a line without them is not one of ours.
  if (typeof record.chapter !== 'number' || typeof record.rev !== 'number') return null;
  const shape: FilingEnvelope = {
    envelope: FILING_ENVELOPE,
    itemId: record.itemId,
    chapter: record.chapter,
    block: typeof record.block === 'string' ? record.block : null,
    rev: record.rev,
    kind: typeof record.kind === 'string' ? record.kind : null,
    author: asValue(record.author),
    quote: asValue(record.quote),
    text: asValue(record.text),
    proposed: asValue(record.proposed),
    // A file may carry any `world` it likes: the server builds that field from its own rows, so a
    // line read back from disk never supplies one.
    world: trusted(null),
  };
  return shape;
}

function asValue(value: unknown): UntrustedValue {
  if (value === null || typeof value !== 'object') return untrusted(null);
  const record = value as Record<string, unknown>;
  return untrusted(typeof record.value === 'string' ? record.value : null);
}

/**
 * The post-check's normal form (BOOK-DOC-42 §2): NFKC, C0/C1 and invisibles to a space, every
 * whitespace run to one space, trim, then the look-alike fold the pre-filter already uses.
 * Two strings that a reader cannot tell apart must compare equal here.
 */
export function norm(value: string): string {
  return foldForMatch(spaceInvisible(value).replace(/\s+/gu, ' ').trim());
}

/**
 * The bound on a quote: past this a match is evidence, below it the quote would match half the
 * book. It is a bound on the **quote**, never on the filing — a field shorter than this has
 * exactly one checkable quote, itself (see `quoteIn`).
 */
export const QUOTE_MIN_CHARS = 12;

/**
 * A quote qualifies only when it is long enough and really sits in the field it names.
 *
 * The minimum is per field, capped by the field's own length: «a quote must be checkable», not
 * «a filing must be long». A filing whose whole text is «он чихнул» (nine normalised characters)
 * can never carry a twelve-character quote of itself, so its one checkable quote is its whole
 * text — a three-character prefix of it is still refused, because it is shorter than the field.
 */
export function quoteIn(fieldValue: string | null, quote: string): boolean {
  if (fieldValue === null) return false;
  const hay = norm(fieldValue);
  const needle = norm(quote);
  if (hay.length === 0 || needle.length === 0) return false;
  const min = Math.min(QUOTE_MIN_CHARS, hay.length);
  return needle.length >= min && hay.includes(needle);
}
