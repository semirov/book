/**
 * lib/chainRuns.mjs — the two runs of `scripts/chain-print-cdp.mjs`, one per width.
 *
 * `anchor` is a phrase every edit leaves alone: it finds the paragraph in the API and in the DOM
 * before, during and after every write. `edits` is the ordered script of writes: the chain's
 * two, the reduced-motion one, the prime print the arrivals join, three arrivals, the late one,
 * and the folio's three forced words. Each `phrase` occurs exactly once in the text it is
 * written against, so a drifted fixture fails loudly instead of editing nothing.
 *
 * `twoPlace` (BOOK-220 §11.2 B3) replaces one sentence with two paragraphs — a write that leaves
 * two changed places, which must print in document order, one at a time. `perfPhrase` names the
 * block the 27 000-character capture grows.
 */

export const RUNS = [
  {
    width: 1440,
    height: 900,
    chapter: 12,
    anchor: 'Я сел на стул',
    edits: [
      // The edit sits mid-paragraph of a nine-line block, so the blue caret climbs five lines and
      // the red one still has lines to descend — even when the frame arrives 400 ms late.
      { id: 'chain-1', phrase: 'Она походила на мою', replacement: 'Она походила на мою подпись, как тень на человека' },
      { id: 'chain-2', phrase: 'как тень на человека', replacement: 'как тень на человека, брошенная на снег' },
      {
        id: 'reduced',
        // A replacement, not an insertion: reduced motion has a strike to show for 600 ms.
        phrase: 'Или была моя, но из другого времени.',
        replacement: 'Или была моя, но из другого срока.',
      },
      // Four sentences with nothing in common: each write's run is the whole sentence, so the
      // ink lasts long enough to arrive into, and a replacement is never a one-word blur.
      {
        id: 'prime',
        phrase:
          'Я узнал бы её среди тысяч: это была подпись, стоявшая на акте 1965 года, на обороте которого значилось «Подпись П.».',
        replacement:
          'Я узнал бы её среди тысяч других подписей, и от этого узнавания мне стало холодно, как бывает, когда находишь своё имя в чужом документе.',
      },
      {
        id: 'arrival-30',
        phrase:
          'Я узнал бы её среди тысяч других подписей, и от этого узнавания мне стало холодно, как бывает, когда находишь своё имя в чужом документе.',
        replacement:
          'В коридоре пахло пылью и старой бумагой, и женщина за стеклом перекладывала листки так, будто каждый из них был чьей-то чужой жизнью.',
      },
      {
        id: 'arrival-70',
        phrase:
          'В коридоре пахло пылью и старой бумагой, и женщина за стеклом перекладывала листки так, будто каждый из них был чьей-то чужой жизнью.',
        replacement:
          'Стрелка над дверью стояла, и я перестал понимать, сколько прошло времени и зачем я всё ещё стою у этого окошка с бумагами в руках.',
      },
      {
        id: 'arrival-95',
        phrase:
          'Стрелка над дверью стояла, и я перестал понимать, сколько прошло времени и зачем я всё ещё стою у этого окошка с бумагами в руках.',
        replacement:
          'Очередь за спиной дышала и переступала с ноги на ногу, и каждый в ней ждал своей очереди так, как будто она была последней.',
      },
      { id: 'late', phrase: 'как будто она была последней.', replacement: 'как будто она была последней и единственной.' },
    ],
    // BOOK-220 §11.2 B3/B4 — a write that leaves two changed places, and the block the perf
    // capture grows to 27 000 characters.
    twoPlace: {
      phrase: 'как будто она была последней и единственной.',
      replacement: 'Первый новый абзац этой правки.\n\nВторой новый абзац этой правки.',
    },
    perfPhrase: 'Второй новый абзац этой правки.',
  },
  {
    width: 390,
    height: 844,
    chapter: 5,
    anchor: 'Потом понадобились копии',
    edits: [
      { id: 'chain-1', phrase: 'В два ноль четыре окно открылось.', replacement: 'В два ноль четыре окно открылось, и я поднялся.' },
      { id: 'chain-2', phrase: 'окно открылось, и я поднялся.', replacement: 'окно открылось, и я поднялся к самому стеклу.' },
      // A replacement (the strike has something to hold), and it keeps «не читая.» for the prime.
      { id: 'reduced', phrase: 'зелёный и размытый.', replacement: 'зелёный и мутный, не читая.' },
      {
        id: 'prime',
        phrase: 'не читая.',
        replacement:
          'не читая. Она перекладывала бумаги с места на место, и я ждал, хотя ждать было уже нечего.',
      },
      {
        id: 'arrival-30',
        phrase: 'не читая. Она перекладывала бумаги с места на место, и я ждал, хотя ждать было уже нечего.',
        replacement:
          'не читая. За стеклом шуршали листки, и каждый был чьей-то чужой просьбой, к которой я не имел отношения.',
      },
      {
        id: 'arrival-70',
        phrase:
          'не читая. За стеклом шуршали листки, и каждый был чьей-то чужой просьбой, к которой я не имел отношения.',
        replacement:
          'не читая. Я считал минуты до конца приёма и не мог досчитать, потому что часы над дверью стояли.',
      },
      {
        id: 'arrival-95',
        phrase:
          'не читая. Я считал минуты до конца приёма и не мог досчитать, потому что часы над дверью стояли.',
        replacement:
          'не читая. Очередь за спиной дышала и переступала, и я перестал понимать, зачем стою и чего жду.',
      },
      { id: 'late', phrase: 'чего жду.', replacement: 'чего жду и куда пойду.' },
      // BOOK-220 B3 — the folio gap's three forced words, each a write of its own so the head
      // says «сейчас записывает» while the rects are read at that width (`folioGap`).
      { id: 'folio-1440', phrase: 'чего жду и куда пойду.', replacement: 'чего жду, куда пойду и зачем.' },
      { id: 'folio-768', phrase: 'куда пойду и зачем.', replacement: 'куда пойду и зачем — не знаю.' },
      { id: 'folio-390', phrase: 'зачем — не знаю.', replacement: 'зачем — не знаю, и это честно.' },
    ],
    twoPlace: {
      phrase: 'зачем — не знаю, и это честно.',
      replacement: 'Первый новый абзац этой правки.\n\nВторой новый абзац этой правки.',
    },
    perfPhrase: 'Второй новый абзац этой правки.',
  },
];
