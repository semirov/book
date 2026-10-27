/**
 * BOOK-58/BOOK-59 — the terms a reader accepts, in one place, with a version.
 *
 * The wording is the lawyer's memo (BOOK-DOC-40 §8 A and §7a): an assignment of the exclusive
 * right in an accepted variant, with a fallback simple licence if the assignment does not
 * stand. Three surfaces print it — /rules, the submit line under the button, and the receipt
 * of an accepted variant — so all three read the same constant and none can drift alone.
 *
 * `TERMS_VERSION` is the record's half of the promise: `terms.test.ts` pins this version to
 * the exact copy, so editing a sentence without bumping the version fails the suite. Bump it
 * whenever a reader-visible word here changes, because the acceptance row stores the version
 * the reader actually accepted (§10 of the memo).
 */

/** The version a submission records; a text change without a bump is a failing test. */
export const TERMS_VERSION = '2026-10-27.1';

/**
 * Variant A — strict, names the instrument (BOOK-DOC-40 §8 A, verbatim). Ownership of the
 * variant passes only when it is entered into the book; authorship and the name stay.
 */
export const RIGHTS_ASSIGNMENT =
  'Если вариант внесён в книгу, вы отчуждаете исключительное право на него автору книги — ' +
  'Филиппу Семирову — в полном объёме и безвозмездно. Отправляя вариант, вы делаете это ' +
  'предложение; оно принимается в момент внесения, и тогда право переходит к автору. ' +
  'Отклонённый вариант остаётся вашим: права на него вы не передаёте. Авторство, имя и ' +
  'защита от искажения остаются у вас — закон не позволяет их передать. Вы разрешаете ' +
  'сокращать, править и переписывать свой текст в прозу книги. Факты, имена и числа ' +
  'авторским правом не охраняются. Вы подтверждаете, что текст ваш и не нарушает чужих прав.';

/**
 * The fallback (BOOK-DOC-40 §7a): if the transfer does not stand — void for form, or re-read
 * as a licence — the reader's grant is still a simple licence on the same terms. One sentence
 * that turns the worst case back into the state the site lived in before BOOK-58.
 */
export const RIGHTS_FALLBACK =
  'Если передача не состоится, вы даёте простую (неисключительную) лицензию на весь срок ' +
  'действия права, весь мир, с правом переработки.';

/** Under the button: what pressing it offers, and that the offer waits for внесение. */
export const SUBMIT_LINE =
  'Отправляя, вы предлагаете передать исключительное право на вариант автору книги — если его внесут.';

/** The receipt of an entered variant: the right moved with the text, and says so once. */
export const RECEIPT_RIGHTS = 'право на ваш текст перешло автору книги';

/** «внесено в главу 07 · право на ваш текст перешло автору книги» — the number is the caller's. */
export function receiptLine(chapter: string): string {
  return `внесено в главу ${chapter} · ${RECEIPT_RIGHTS}`;
}
