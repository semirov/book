/**
 * One submission's text, read once for both paths (BOOK-158).
 *
 * A new filing and a revision are judged by the same bounds: the note cap (`COMMENT_MAX_CHARS`)
 * for the body, the intervention cap (`EDIT_MAX_CHARS`) for a proposed wording, and the kind
 * rule (BOOK-16) for an intervention. Keeping the reading in one place is what makes a
 * revision unable to smuggle in a wider field than the composer promises — the two paths cannot
 * drift because there is only one of them.
 *
 * The bytes are checked before the sanitizer: a 10 000-character Cyrillic intervention is
 * 20 000 B, and the raw bound is sized so the promise the composer shows is the one the server
 * keeps.
 */

import {
  COMMENT_MAX_CHARS,
  COMMENT_RAW_MAX_BYTES,
  EDIT_MAX_CHARS,
  EDIT_RAW_MAX_BYTES,
  type InterventionKind,
} from '@book/shared';

import { fail, isPresent, type ServiceFailure } from './failure.ts';
import { checkInterventionKind } from './intervention.ts';
import { sanitizeBody, sanitizeProposed } from './sanitize.ts';

export type FilingTextInput = {
  body: unknown;
  proposedText?: string | null;
  interventionKind?: unknown;
};

export type FilingText = {
  ok: true;
  /** The stored form and its hash — the ledger's `body_sha` comes from here, never from a copy. */
  body: { text: string; hash: string };
  proposedText: string | null;
  kind: InterventionKind | null;
};

export function readFilingText(input: FilingTextInput): FilingText | ServiceFailure {
  if (typeof input.body !== 'string') return fail(422, 'INVALID', 'нужен текст замечания');
  if (Buffer.byteLength(input.body, 'utf8') > COMMENT_RAW_MAX_BYTES) {
    return fail(422, 'TOO_LONG', `замечание длиннее ${COMMENT_MAX_CHARS} символов`);
  }
  const body = sanitizeBody(input.body);
  if (!body.ok) return fail(422, body.code, body.message);

  let proposedText: string | null = null;
  if (isPresent(input.proposedText)) {
    if (Buffer.byteLength(input.proposedText, 'utf8') > EDIT_RAW_MAX_BYTES) {
      return fail(422, 'TOO_LONG', `правка длиннее ${EDIT_MAX_CHARS} символов`);
    }
    const proposed = sanitizeProposed(input.proposedText);
    if (proposed === null || !proposed.ok) {
      return fail(
        422,
        proposed === null ? 'INVALID' : proposed.code,
        proposed?.message ?? 'предложенная правка пустая',
      );
    }
    proposedText = proposed.text;
  }

  // BOOK-16: an intervention carries exactly one of the four kinds (BOOK-DOC-4 rule 1), and a
  // note carries none. Checked before anything is stored, so a refusal costs no slot.
  const kind = checkInterventionKind(input.interventionKind, proposedText !== null);
  if (kind.ok === false) return fail(422, kind.code, kind.message);

  return { ok: true, body: { text: body.text, hash: body.hash }, proposedText, kind: kind.kind };
}
