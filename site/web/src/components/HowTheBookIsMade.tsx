/**
 * «Как сделана книга» — the site's own explanation of the machine (BOOK-39, owner's text of
 * 2026-10-27). It stands between the cover and the book's first words, and it is **not**
 * manuscript text: it names the auditor, the writer and the wave, so it describes the process
 * rather than belonging to the story. It therefore lives here as web copy and never enters
 * `manuscript/`, never reaches the writer, and never appears in `/api/front`'s `about`.
 *
 * The three paragraphs are reproduced verbatim from the owner's proofread text: no edit, no
 * typography pass, no re-count, no markdown parsing, no heading, no button. They are one
 * constant so that the only way to change them is to change the author's words deliberately.
 */
export const HOW_THE_BOOK_IS_MADE: readonly string[] = [
  'Мы пишем книгу без готового плана. Есть начало, конец и шестьдесят семь пустых глав между ними. Читатель предлагает вмешательство; аудитор решает, может ли оно существовать в этом мире; писатель вплетает его в текст. Принятая фраза расходится волной по соседним главам — вперёд и назад, пока история снова не сойдётся.',
  'Прошлое при этом не маскируется, а оформляется: у всякой причины появляется бланк. Иногда документ и сцена совпадают. Иногда — нет.',
  'Авторство здесь не измеряется числом написанных слов. Оно измеряется тем, что дожило.',
];

/**
 * The block itself: three paragraphs in the reading column, no visible label, no box, no
 * animation. The rule that closes it is the opening screen's (see `Opening`), because a
 * `***` is a rule in the layout and never a character in a string.
 */
export function HowTheBookIsMade() {
  return (
    <section className="page how-made">
      {HOW_THE_BOOK_IS_MADE.map((paragraph, index) => (
        <p className="p" key={index}>
          {paragraph}
        </p>
      ))}
    </section>
  );
}
