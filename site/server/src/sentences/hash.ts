/**
 * The content attribute of a sentence (ADR-044 §2.1) — an attribute, never the identity.
 *
 * The normalisation is the narrowest one that makes «the same words» one value: NFC (so a
 * decomposed `й` and a composed one agree), whitespace runs collapsed to one space, edges
 * trimmed. Case and punctuation are **kept**: «Он пришёл.» and «Он пришёл?» are different
 * sentences, and a hash that merged them would re-attach a fact to the wrong words.
 *
 * `blake2b512` is computed whole and sliced: Node's `createHash` rejects `outputLength` for
 * BLAKE2 (`ERR_CRYPTO_INVALID_OPTION`), so the first 128 bits are taken from the hex digest —
 * exactly what the ADR's `text_hash` column stores, as 32 lowercase hex characters.
 */

import { createHash } from 'node:crypto';

/** NFC, whitespace runs collapsed, edges trimmed — the sentence as a comparable value. */
export function normaliseSentence(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** blake2b-128 of the normalised sentence, as 32 hex characters. */
export function sentenceHash(text: string): string {
  return createHash('blake2b512').update(normaliseSentence(text), 'utf8').digest('hex').slice(0, 32);
}
