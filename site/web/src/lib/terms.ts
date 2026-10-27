/**
 * BOOK-58/BOOK-59 — the terms a reader accepts, in one place, with a version.
 *
 * The wording is the lawyer's memo (BOOK-DOC-40 §8 A and §7a): an assignment of the exclusive
 * right in an accepted variant, with a fallback simple licence if the assignment does not
 * stand. Three surfaces print the terms — /rules, the submit line under the button, and the
 * receipt of an accepted variant — so all three read the same constant and none can drift
 * alone. BOOK-72/BOOK-69 widen the /rules surface: the same page also prints the tool clause
 * (`TOOL_CLAUSE`) next to the assignment, the list of what stays with the reader
 * (`RIGHTS_RETAINED`), and the section that names who writes the book at all
 * (`MACHINE_TOOL_RULES`, `MACHINE_TOOL_CAVEAT`) — so those read from here too, not from the
 * component.
 *
 * `TERMS_VERSION` is the record's half of the promise: `terms.test.ts` pins this version to
 * the exact copy, so editing a sentence without bumping the version fails the suite. Bump it
 * whenever a reader-visible word here changes, because the acceptance row stores the version
 * the reader actually accepted (§10 of the memo).
 */

/** The version a submission records; a text change without a bump is a failing test. */
export const TERMS_VERSION = '2026-10-28.1';

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

/**
 * BOOK-69 — the tool clause, printed inside the terms block right after the assignment. The
 * machine is named where the right changes hands, so the transfer cannot be read as a grant to
 * a program: the right of authorship arises only in a person, and the person it moves to here
 * is the book's author.
 */
export const TOOL_CLAUSE =
  'Машина — инструмент, не автор и не правообладатель: авторские права возникают только у ' +
  'людей — и передаются человеку, автору книги.';

/**
 * BOOK-72 — what the same page promises is not transferred, said as a list a reader can
 * check: authorship and the name cannot pass at all, a rejected variant stays whole, a note
 * without a type gives nothing away, and hiding the name changes the show, not the right.
 */
export const RIGHTS_RETAINED: readonly string[] = [
  'Авторство и имя остаются вашими — закон не позволяет их передать. Остаётся и защита от искажения, которое вас порочит.',
  'Отклонённый вариант остаётся вашим целиком: на него ничего не передано.',
  'Замечание без типа ничего не передаёт — это не вмешательство.',
  'Скрыть себя из списка авторов меняет только показ: права и ваша доля остаются.',
];

/**
 * BOOK-69 — «Кто пишет книгу»: who writes, who decides, and why a program holds nothing.
 * A reader meets the machine in every other section of the page, so the page names it once
 * as a tool of the author rather than a party to the book.
 */
export const MACHINE_TOOL_RULES =
  'Книгу пишет человек. Машина — инструмент: она читает вмешательство, проверяет, ' +
  'укладывается ли оно в книгу, и набрасывает прозу по заданию автора. Автор — Филипп ' +
  'Семиров: канон, замысел и решения его. У машины нет авторства и нет прав — ни у неё, ни ' +
  'у её разработчика: по закону автором может быть только человек. Поэтому в списке авторов ' +
  'и в выходных данных стоят люди, а не программа.';

/**
 * BOOK-69 — the caveat that keeps the section honest: the law around a wholly machine-written
 * text has not settled, so the book rests on the canon and the author's decisions, not on the
 * tool that drafts the prose.
 */
export const MACHINE_TOOL_CAVEAT =
  'Право здесь не устоялось: текст, целиком написанный машиной без творческого вклада ' +
  'человека, может не охраняться вовсе — поэтому книга держится на каноне, задании и ' +
  'решениях автора, а не на машине.';

/** Under the button: what pressing it offers, and that the offer waits for внесение. */
export const SUBMIT_LINE =
  'Отправляя, вы предлагаете передать исключительное право на вариант автору книги — если его внесут.';

/** The receipt of an entered variant: the right moved with the text, and says so once. */
export const RECEIPT_RIGHTS = 'право на ваш текст перешло автору книги';

/** «внесено в главу 07 · право на ваш текст перешло автору книги» — the number is the caller's. */
export function receiptLine(chapter: string): string {
  return `внесено в главу ${chapter} · ${RECEIPT_RIGHTS}`;
}
