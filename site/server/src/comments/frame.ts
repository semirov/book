import type { CommentAddedPayload, CommentDto } from '@book/shared';

/**
 * BOOK-158 — the frame one stored filing is broadcast as.
 *
 * A post and a revision are two writers of **one** row, so they must speak the same frame: a
 * second tab reads `comment:added` only as «this chapter moved» and re-reads it
 * (`App.tsx`), and a revision that sent no frame left that tab saying «можно повторить через
 * 10 минут» until a reload. One shape, taken from the refreshed DTO, so the two paths cannot
 * drift.
 */
export function commentAddedPayload(dto: CommentDto): CommentAddedPayload {
  return {
    id: dto.id,
    chapter: dto.chapter,
    anchor: dto.anchor,
    author: dto.author,
    authorColor: dto.authorColor,
    body: dto.body,
    interventionKind: dto.interventionKind,
    status: dto.status,
    reason: dto.reason,
    createdAt: dto.createdAt,
  };
}
