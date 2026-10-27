/**
 * Resolving an operator's typed handle to exactly one identity (BOOK-113).
 *
 * The admin CLI and the two budget routes accept the three forms an operator actually has at
 * hand, and nothing else:
 *
 * - the internal id (`idt_01M5…`) — the key itself, printed by the CLI and the admin panel;
 * - the display name, trimmed and case-insensitive («Филипп Семиров» = «филипп семиров»);
 * - the public alias — `sha256(id)` truncated to 12 hex characters (`util/alias.ts`), the
 *   handle the site already publishes.
 *
 * The product has no unique display name, so this never guesses: one match is the answer, no
 * match is `NOT_FOUND`, and more than one is `AMBIGUOUS` with the candidates, for the operator
 * to disambiguate by id. The comparison happens in JavaScript because SQLite's `LOWER()` folds
 * ASCII only — «Аня» and «аня» would otherwise be two different names.
 */

import type { Db } from '../db/db.ts';
import { publicAlias, ALIAS_LENGTH } from '../util/alias.ts';

export type IdentityCandidate = { id: string; displayName: string };

export type ResolveResult =
  | { ok: true; identity: IdentityCandidate & { editExempt: number } }
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'AMBIGUOUS'; candidates: IdentityCandidate[] };

type Row = { id: string; display_name: string; edit_exempt: number };

/** The 12-hex public handle, and nothing that only looks like one. */
const ALIAS = new RegExp(`^[0-9a-f]{${String(ALIAS_LENGTH)}}$`, 'iu');

export function resolveIdentity(db: Db, query: string): ResolveResult {
  const needle = query.trim();
  if (needle.length === 0) return { ok: false, code: 'NOT_FOUND' };

  const rows = db
    .prepare('SELECT id, display_name, edit_exempt FROM identities')
    .all() as Row[];

  // The id is the key: an exact hit is never ambiguous, whatever else the string resembles.
  const byId = rows.find((row) => row.id === needle);
  if (byId !== undefined) return found(byId);

  const alias = ALIAS.test(needle) ? needle.toLowerCase() : null;
  const name = needle.toLowerCase();
  const matches = rows.filter(
    (row) =>
      (alias !== null && publicAlias(row.id) === alias) ||
      row.display_name.trim().toLowerCase() === name,
  );

  const first = matches[0];
  if (first === undefined) return { ok: false, code: 'NOT_FOUND' };
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS',
      candidates: matches.map((row) => ({ id: row.id, displayName: row.display_name })),
    };
  }
  return found(first);
}

function found(row: Row): ResolveResult {
  return {
    ok: true,
    identity: { id: row.id, displayName: row.display_name, editExempt: row.edit_exempt },
  };
}
