/**
 * Where a filing attaches (ARCHITECTURE.md §9, §12.1, BOOK-7) — its own module because it is a
 * decision about the text, not part of the posting order.
 *
 * A comment attaches to a paragraph from one revision. If that paragraph has changed, the
 * composer must be told (`STALE_ANCHOR`) rather than attach the note to the wrong place. The
 * frozen frame is decided from the slot itself — ch01 and ch67 are never targets, whether or not
 * the projection already holds their basis sentence — and premise vs ordinary is decided by
 * whether the slot is *written* (`basis`/`block_count`), not by the absence of a row: a basis
 * slot has a row, and it is still not prose. A chapter-level intervention on an unwritten slot
 * is that slot's premise (base revision 0, no block).
 */

import {
  PREMISE_FROZEN_REASON,
  TOTAL_CHAPTERS,
  type CommentAnchor,
  type PostCommentInput,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { fail, isPresent, type ServiceFailure } from './failure.ts';
import { readBlock, readChapterBase } from './repo.ts';
import { sanitizeAffix, sanitizeQuote } from './sanitize.ts';

export type AnchorResult =
  | { ok: true; anchor: CommentAnchor; baseRev: number | null }
  | { ok: false; failure: ServiceFailure };

export function resolveAnchor(db: Db, input: PostCommentInput): AnchorResult {
  if (input.chapter === 1 || input.chapter === TOTAL_CHAPTERS) {
    return { ok: false, failure: fail(403, 'FROZEN_FRAME', PREMISE_FROZEN_REASON) };
  }
  const base = readChapterBase(db, input.chapter);
  const quote = sanitizeQuote(input.quote);
  const blockId = isPresent(input.blockId) ? input.blockId : null;
  const baseRev = typeof input.baseRev === 'number' ? input.baseRev : null;

  if (base === undefined || base.basis !== 0 || base.blockCount === 0) {
    if (blockId !== null) {
      return {
        ok: false,
        failure: fail(409, 'STALE_ANCHOR', 'глава ещё не написана — замечание можно оставить к главе целиком'),
      };
    }
    return {
      ok: true,
      baseRev: 0,
      anchor: {
        blockId: null,
        blockIndex: null,
        quote: null,
        prefix: sanitizeAffix(input.prefix),
        suffix: sanitizeAffix(input.suffix),
        resolved: true,
      },
    };
  }

  if (blockId === null) {
    return {
      ok: true,
      // BOOK-111: a chapter-wide note on a **written** chapter is not a premise, and the
      // schema defines a premise as `base_rev 0`. A crafted or leftover `0` (or a negative)
      // must never be stored here, or `toCommentDto` would report the reader's note on
      // written text as the chapter's premise: the chapter's own revision is the floor.
      baseRev: baseRev !== null && baseRev > 0 ? baseRev : base.rev,
      anchor: {
        blockId: null,
        blockIndex: null,
        quote: null,
        prefix: sanitizeAffix(input.prefix),
        suffix: sanitizeAffix(input.suffix),
        resolved: true,
      },
    };
  }

  const block = readBlock(db, blockId);
  const stale =
    block === undefined ||
    block.chapter !== input.chapter ||
    (quote !== null && !block.text.includes(quote)) ||
    (baseRev !== null && baseRev !== base.rev);
  if (stale) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 409,
        code: 'STALE_ANCHOR',
        message: 'абзац изменился — вот он сейчас, привяжите замечание заново',
        ...(block === undefined ? {} : { currentText: block.text }),
      },
    };
  }

  return {
    ok: true,
    baseRev: baseRev ?? base.rev,
    anchor: {
      blockId,
      blockIndex: block.idx,
      quote,
      prefix: sanitizeAffix(input.prefix),
      suffix: sanitizeAffix(input.suffix),
      resolved: true,
    },
  };
}
