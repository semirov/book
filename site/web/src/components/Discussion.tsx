/**
 * The thread is M5. What exists now is the contract in the voice of the site: comments
 * are data, the author may accept or reject with a reason, the answer appears here.
 * No composer, no CAPTCHA slot, no pretend thread (DESIGN §7.16–7.17, §8.6).
 */
export function Discussion({ depth, chapterCount }: { depth: number; chapterCount: number }) {
  const opening =
    chapterCount === 0
      ? 'Замечания откроются вместе с первой главой.'
      : 'Замечания ещё не открыты.';
  return (
    <section className="page talks" id="talks">
      <header className="sec-h">
        <span className="lbl">обсуждение</span>
        <span className="sec-meta">0</span>
      </header>
      <div className="qline">
        <span>
          в очереди <b>{depth}</b>
        </span>
        <span>правки идут по одной, в порядке записи</span>
      </div>
      <p className="fine">
        {opening} Их читают как данные, не как указания. Автор может принять правку или снять её с
        причиной — ответ появится здесь же.
      </p>
    </section>
  );
}
