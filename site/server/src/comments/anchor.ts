/**
 * Where a filing attaches (ARCHITECTURE.md §9, §12.1, BOOK-7, BOOK-137) — its own module
 * because it is a decision about the text, not part of the posting order.
 *
 * A comment attaches to a paragraph from one revision. If that paragraph has changed, the
 * composer must be told (`STALE_ANCHOR`) rather than attach the note to the wrong place.
 *
 * BOOK-137: the frozen frame is not a closed door any more. A reader may file on ch01's opening
 * or ch42's finale; the sentence's letters are protected where a landing touches them
 * (`engine/write.ts`), and an accepted filing that touches them becomes paperwork
 * (`feedback/accept.ts`). So a block anchor resolves like prose on every chapter — the basis
 * slot's own paragraph included — and only a **chapter-level** anchor of an unwritten slot takes
 * the premise branch.
 *
 * BOOK-7: premise vs ordinary is decided by whether the slot is *written* (`basis`/`block_count`),
 * not by the absence of a row: a basis slot has a row, and it is still not prose. A
 * chapter-level intervention on an unwritten slot is that slot's premise (base revision 0, no
 * block).
 *
 * The same pass returns the chapter's block count and the resolved block's own text/index, so
 * the caller can classify the filing against the frame without a second read.
 */

import { type CommentAnchor, type PostCommentInput } from '@book/shared';

import type { Db } from '../db/db.ts';
import { isPresent, type ServiceFailure } from './failure.ts';
import { readBlock, readChapterBase } from './repo.ts';
import { sanitizeAffix, sanitizeQuote } from './sanitize.ts';

export type AnchorResult =
  | {
      ok: true;
      anchor: CommentAnchor;
      baseRev: number | null;
      /** Paragraphs the chapter held when the filing was made (0 for an unwritten slot). */
      blockCount: number;
      /** The anchored block's text; `null` for a chapter-level filing. */
      blockText: string | null;
    }
  | { ok: false; failure: ServiceFailure };

export function resolveAnchor(db: Db, input: PostCommentInput): AnchorResult {
  const base = readChapterBase(db, input.chapter);
  const quote = sanitizeQuote(input.quote);
  const blockId = isPresent(input.blockId) ? input.blockId : null;
  const baseRev = typeof input.baseRev === 'number' ? input.baseRev : null;
  const blockCount = base?.blockCount ?? 0;

  // A block anchor is prose on every chapter (BOOK-137): ch01's and ch42's own paragraphs are
  // told apart by the frame mark the caller takes, never refused here. Even a basis slot has its
  // paragraph as a block, so the reader may attach to the canon sentence itself.
  if (blockId !== null) {
    const block = readBlock(db, blockId);
    const stale =
      block === undefined ||
      block.chapter !== input.chapter ||
      (quote !== null && !block.text.includes(quote)) ||
      (baseRev !== null && base !== undefined && baseRev !== base.rev);
    if (stale) {
      return {
        ok: false,
        failure: {
          ok: false,
          status: 409,
          code: 'STALE_ANCHOR',
          message: block === undefined
            ? 'глава ещё не написана — замечание можно оставить к главе целиком'
            : 'абзац изменился — вот он сейчас, привяжите замечание заново',
          ...(block === undefined ? {} : { currentText: block.text }),
        },
      };
    }
    return {
      ok: true,
      baseRev: baseRev ?? (base?.rev ?? 0),
      blockCount,
      blockText: block.text,
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

  // A chapter-level filing of a slot with no prose is that slot's premise (BOOK-7).
  if (base === undefined || base.basis !== 0 || base.blockCount === 0) {
    return {
      ok: true,
      baseRev: 0,
      blockCount,
      blockText: null,
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

  return {
    ok: true,
    // BOOK-111: a chapter-wide note on a **written** chapter is not a premise, and the
    // schema defines a premise as `base_rev 0`. A crafted or leftover `0` (or a negative)
    // must never be stored here, or `toCommentDto` would report the reader's note on
    // written text as the chapter's premise: the chapter's own revision is the floor.
    baseRev: baseRev !== null && baseRev > 0 ? baseRev : base.rev,
    blockCount,
    blockText: null,
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
