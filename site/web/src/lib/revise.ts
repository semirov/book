import type { CommentRevise, CommentDto, ReviseCommentInput } from '@book/shared';

import { submissionBody, type SeamDraft } from './draft.ts';
import { plural } from './format.ts';
import { firstWord, type SeamAnchor, type Sentence } from './seam.ts';

/**
 * BOOK-158 — the way back from a refusal, on the page.
 *
 * A refused filing is not a dead end and not a reason to write the same thing again: the row
 * says why it was refused (`reason`), what would make it pass (`hint`) and whether the reader
 * may try now (`revise`). «исправить» then reopens the strip with the filing's own text in it,
 * and the form submits a **revision of that row** — the same id, chapter and anchor — instead
 * of a second near-duplicate.
 *
 * Everything a limit owes the reader is computed here, from the server's own fields, and never
 * from a frozen number: the cooldown is read from `revise.at` against the clock at render, and
 * a filing whose `revise` is missing (an older server) is simply not revisable — the page says
 * nothing about a limit it was not told about.
 */

/** The door on a refused filing. One word, the same in the row and in the card. */
export const REVISE_LABEL = 'исправить';

/**
 * The accounting, printed once under the submit of a revision: the day's edit is spent by an
 * **accepted** filing, never by a try, and the tries are counted on their own (§BOOK-158).
 */
export const REVISE_BUDGET_LINE =
  'одна правка в сутки списывается только за принятую; попытки считаются отдельно';

/** The filing's own day is spent: the next try comes with the next 00:00 UTC. */
export const REVISE_EXHAUSTED = 'исчерпаны попытки — в следующий раз';

/** One reader, or one network, has asked for too many judgements today. One public sentence. */
export const REVISE_ATTEMPT_LIMIT = 'слишком много попыток сегодня — попробуйте завтра';

/**
 * «можно повторить через 7 минут» — the cooldown, in whole minutes, never less than one.
 *
 * The countdown is read from the refusal's own end (`revise.at`) at the moment the surface
 * renders; nothing is frozen into the DTO, so a page left open overnight does not keep saying
 * «через 10 минут» about a window that closed hours ago.
 */
export function cooldownLine(at: string | null, nowMs: number): string {
  const until = at === null ? Number.NaN : Date.parse(at);
  const left = Number.isFinite(until) ? until - nowMs : 0;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return `можно повторить через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
}

/** Why the way back is closed when the server names the limit, else `null` (no claim). */
function blockedLine(state: CommentRevise | undefined, nowMs: number): string | null {
  if (state === undefined) return null;
  // The server's own order: the cooldown stands before the day's counters.
  if (state.blocked === 'cooldown') return cooldownLine(state.at, nowMs);
  if (state.blocked === 'attempts' || state.closed) return REVISE_EXHAUSTED;
  if (state.blocked === 'identity' || state.blocked === 'network') return REVISE_ATTEMPT_LIMIT;
  return null;
}

/**
 * What a filing's surface shows beside its state: the actionable hint, the door when it is
 * open, and the sentence that says why it is closed. `null` for a filing no gate refused — a
 * pending or landed row owes no line at all.
 *
 * `allowed` is the server's answer, never a guess (`CommentRevise.allowed`); a held or
 * quarantined filing keeps its hint and gets no door, because there is nothing to wait out.
 */
export type ReviseView = {
  hint: string | null;
  /** The reader may submit a revision now. */
  allowed: boolean;
  /**
   * Why the door is closed — «можно повторить через 7 минут», «исчерпаны попытки — в следующий
   * раз», «слишком много попыток сегодня — попробуйте завтра». `null` when the server named no
   * limit: a held filing, or a page talking to a server that predates BOOK-158.
   */
  blocked: string | null;
};

export function reviseView(comment: CommentDto, nowMs: number = Date.now()): ReviseView | null {
  const hint = comment.hint ?? null;
  // BOOK-174: two states are the reader's to rework — a refusal under a lock, and a filing that
  // waits for the author (a revision withdraws it from the author's desk). Everything else is
  // `NOT_REVISABLE` on the server; a held one still owes its hint — «уберите из текста указания
  // в адрес модели».
  if (comment.status !== 'rejected' && comment.status !== 'escalated') {
    return hint === null ? null : { hint, allowed: false, blocked: null };
  }
  const allowed = comment.revise?.allowed === true;
  return { hint, allowed, blocked: allowed ? null : blockedLine(comment.revise, nowMs) };
}

/**
 * The draft «исправить» writes into the strip: the filing's own text, in the field the reader
 * first typed it in. One tap, no retyping — and the draft keeps the filing's chapter, block,
 * sentence and kind, so the reopened form is about the same place in the book.
 *
 * A note is one text and no kind (BOOK-57); a premise is the chapter's own text; an
 * intervention carries its wording and the kind that wording belongs to (BOOK-16).
 */
export function reviseDraft(comment: CommentDto): SeamDraft {
  const blockId = comment.anchor.blockId;
  const noteOnly = blockId !== null && comment.interventionKind === null;
  return {
    chapter: comment.chapter,
    blockId,
    // The revise endpoint carries no anchor, so no revision is claimed: the key and the strip
    // mark the filing's own sentence, and the payload the server judges has no `baseRev`.
    baseRev: null,
    blockIndex: comment.anchor.blockIndex,
    sentence: comment.anchor.quote ?? '',
    kind: comment.interventionKind,
    noteOnly,
    body: comment.body,
    proposed: comment.proposedText ?? comment.body,
    revisesId: comment.id,
  };
}

/**
 * The anchor the strip opens on for a **block** filing: the filing's own place, built from the
 * stored quote. It is the strip's host, not a new claim about the text — the revision keeps the
 * row's anchor on the server whatever this object says.
 */
export function reviseAnchor(comment: CommentDto): SeamAnchor | null {
  const blockId = comment.anchor.blockId;
  const quote = comment.anchor.quote;
  if (blockId === null || quote === null || quote.trim().length === 0) return null;
  const sentence: Sentence = { text: quote, start: 0, end: quote.length };
  return {
    blockId,
    baseRev: null,
    quote,
    prefix: comment.anchor.prefix ?? '',
    suffix: comment.anchor.suffix ?? '',
    sentence,
    word: firstWord(quote),
  };
}

/**
 * What a revision sends: the words, never the anchor. The server keeps the filing's chapter,
 * block, quote and revision, so a revision cannot move the filing to another paragraph.
 *
 * A wording travels with its kind, exactly as at posting (BOOK-16): the server refuses a kind
 * without text and text without a kind. A note, and a premise stored without a kind, are one
 * text and send the body alone.
 */
export function revisePayload(
  draft: Pick<SeamDraft, 'body' | 'proposed' | 'kind' | 'noteOnly' | 'blockId'>,
): ReviseCommentInput {
  const body = submissionBody(draft);
  if (draft.noteOnly || draft.kind === null) return { body };
  return { body, proposedText: draft.proposed, interventionKind: draft.kind };
}
