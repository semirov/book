/**
 * The public alias of a reader's identity (audit m3).
 *
 * `identities.id` is an internal key: it joins a session, a rate bucket, a change and a
 * comment, so publishing it lets anyone correlate a reader across every surface — and it is
 * stable forever. The end matter and the contributors list only need *a* stable handle for a
 * React key and for "the same reader", never the key itself, so they publish
 * `sha256(identityId)` truncated to 48 bits.
 *
 * The alias is one-way and cheap: it is derived, never stored, and the raw id stays where it
 * belongs — in the log and behind the admin token.
 */

import { sha256Hex } from './hash.ts';

/** 12 hex characters = 48 bits: enough for a handful of readers, useless as a reverse key. */
export const ALIAS_LENGTH = 12;

export function publicAlias(identityId: string): string {
  return sha256Hex(identityId).slice(0, ALIAS_LENGTH);
}
