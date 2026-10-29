import { ageDayIn } from '@book/shared';

/**
 * The rating and the gate, in one place (BOOK-225).
 *
 * The book is 18+, and that is a fact of the book, stated in two surfaces of its own: the
 * footer's row and the rules document. Both print from here, so the sentence cannot drift into
 * a second wording — and the gate prints the same one sentence rather than a paragraph about it.
 *
 * The voice: marks and actions are lowercase, the rating is the literal `18+`, and a sentence
 * starts as a sentence does. No badge, no colour, no exclamation, no legal boilerplate — and no
 * moralising. What is inside the book is the genre, not a warning about the reader, and nothing
 * here says a word about what a reader may or may not read.
 *
 * The gate's own line is the same fact in a sentence, because a reader who meets the gate has
 * not seen the footer yet. The two doors are words, not buttons of paint: forward answers the
 * question, out leaves the book.
 */
export const AGE_LABEL = '18+';

/** The footer row: the rating and, after the dot, what it means in the book's own words. */
export const AGE_COLOPHON_LINE = `${AGE_LABEL} · насилие, кровь и взрослые темы`;

/** `/rules` — the section heading and its one paragraph. */
export const AGE_RULES_HEADING = 'кому это читать';
export const AGE_RULES_BODY = `Книге ${AGE_LABEL}. Внутри — насилие, кровь и взрослые темы: это жанр, и текст не смягчается.`;

/** The gate's sentence: the same fact, one line, before the prose. */
export const AGE_GATE_LINE = 'В книге есть насилие, кровь и взрослые темы.';
/** The two doors. The forward one is an act (`button`); the way out is a real link. */
export const AGE_GATE_FORWARD = 'мне есть 18 — читать';
export const AGE_GATE_LEAVE = 'мне нет 18 — уйти';

/**
 * Where the gate stands right now, read from the device at boot — before the first request, so
 * a reader who already answered never sees the question again and the chapter flow mounts at
 * once. `document.cookie` is the page's copy of the same value the route writes; the reading is
 * the shared one (`ageDayIn`), so a value the server would refuse can never open the gate here.
 */
export function readAgeAcknowledgement(now: Date = new Date()): string | null {
  return ageDayIn(document.cookie, now);
}
