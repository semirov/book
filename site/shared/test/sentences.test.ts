import { describe, expect, it } from 'vitest';

import { SEGMENTER_VERSION, splitSentences, utf16Index } from '../src/sentences.ts';

/**
 * BOOK-DOC-74 (ADR-044) §3.2 — the rule set, one test per rule.
 *
 * The strings are the book's own: `ch12` opens with a quoted notice, `ch08` quotes a letter in
 * one paragraph, `ch05` carries document numbers and dates, `ch11` a commission of initials.
 * They are pasted here rather than read from `manuscript/` so the file cannot drift with the
 * working directory; when the prose changes, the text of the test changes with it on purpose.
 */

/** ch12, paragraph 3: «Утром в щели под дверью лежал сложенный лист.» and the notice. */
const CH12 = `Утром в щели под дверью лежал сложенный лист. Я поднял его, не включая свет. Бумага была казённая, серая, с номером исходящего в правом углу. В тексте значилось: «Вам надлежит явиться в отдел учёта и регистрации для ознакомления с материалами дела № 44/17. При себе иметь документ, удостоверяющий личность. Часы приёма: среда, четверг, с 9 до 13. Кабинет 7. Явиться без вызова повторно нельзя». Внизу стояла подпись — неразборчивая, с длинным хвостом, знакомая мне по акту 1965 года. Я перевернул лист. На обороте карандашом было написано: «Приходи один». Почерк был тот же, что на обороте акта у Пеньковой: аккуратный, мелкий, с наклоном вперёд, и последняя буква уходила вниз. Я стоял в полутьме прихожей и смотрел на эти два слова, как смотрят на чужую записку, подсунутую под дверь в гостинице.`;

/** ch08, paragraph 9: one letter, quoted whole, with an «!», a document number and a semicolon list. */
const CH08 = `«Уважаемый заявитель! — говорилось в нём. — Ваше заявление от 12 декабря сего года, зарегистрированное по делу № 14-УП, направлено в лабораторию судебно-почерковедческой экспертизы № 3 для проведения вероятностного исследования подписи на копии акта от 14 сентября 2065 года. В соответствии с пунктом 6.2 инструкции Вам надлежит явиться по адресу: ул. Изотова, дом 11, корпус 4, кабинет 112, в течение трёх рабочих дней для дачи образцов почерка и подписи. При себе иметь: документ, удостоверяющий личность; корешок уведомления; копию акта; все имеющиеся документы, содержащие Вашу подпись за последние три года. Явка обязательна. Неявка без уважительной причины влечёт оставление заявления без рассмотрения».`;

/** ch05, paragraph 23: document numbers, a date, and «Пункт 4». */
const CH05 = `Через час я получил жёлтый бланк справки с номером 65/11877/арх. В графе «содержание» было напечатано: «Дело № 65/11432/вуч уничтожено по акту № 65/11877/арх от 14.09.2065. Основание: заявление гражданина, отказ от копии. Пункт 4». Я перечитал. Слова были аккуратные, как кладка. «Пункт 4» стояло в конце, как чёрный крестик на карте.`;

/** ch11, paragraph 109: a commission written as initials («Бардин С. Л., …»). */
const CH11 = `Я развернул лист. Это был стандартный бланк: «Акт № 14-2065 от 14 сентября 1965 г.». Текст был напечатан на машинке, пропуски заполнены от руки. В нём значилась комиссия: «Бардин С. Л., Голованова Е. В., Пенькова Н. П.». Тема — «об уничтожении документов, не подлежащих хранению». Ниже стояли три подписи. Первая была неразборчива, с длинным хвостом. Вторая — Головановой, круглая и чёткая. Третья была моей. Я узнал её сразу: тот же левый наклон, та же круглая последняя петля, которую я никогда не мог удержаться, чтобы не переправить. Это была моя подпись, но она была не моя. Она была как будто скопирована с моей руки и положена на эту бумагу за пятьдесят девять лет до того, как я научился писать.`;

/** What every surface did before this module: a terminator and any whitespace. */
const NAIVE = /(?<=[.!?…])\s+/u;

const texts = (text: string): string[] => splitSentences(text).map((span) => span.text);
const naive = (text: string): string[] =>
  text
    .split(NAIVE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

describe('the shared segmenter (BOOK-DOC-74 §3.2)', () => {
  it('R1 splits after a run of terminals and the closers that follow it', () => {
    expect(texts('Он ушёл?! Она молчала… Конец.')).toEqual(['Он ушёл?!', 'Она молчала…', 'Конец.']);
    // The run and its closer are one boundary: «…нельзя». Внизу» is where the notice ends.
    expect(texts('«Приходи один». Почерк был тот же.')).toEqual(['«Приходи один».', 'Почерк был тот же.']);
    // A terminator after a bracket is still a boundary: the closer stays with the sentence.
    expect(texts('Он сел у окна (см. выше). Потом стало тихо.')).toEqual([
      'Он сел у окна (см. выше).',
      'Потом стало тихо.',
    ]);
    // A terminator with no whitespace after it is inside a token, not a boundary.
    expect(texts('Метка 4.5 стояла рядом.')).toEqual(['Метка 4.5 стояла рядом.']);
  });

  it('R2 splits nothing inside a quotation', () => {
    const sentences = texts(CH12);
    const notice = sentences[3] as string;
    expect(notice.startsWith('В тексте значилось: «Вам надлежит')).toBe(true);
    expect(notice.endsWith('Явиться без вызова повторно нельзя».')).toBe(true);
    // The four internal full stops (a document number, a list, a time, a room) are one sentence.
    expect(notice.match(/\./gu)?.length).toBe(5);
    // The letter quoted whole in ch08 holds an «!», several full stops and a semicolon list.
    expect(texts(CH08)).toHaveLength(1);
    // The tracking is a scan of the whole text, so all three of the book's quote pairs hold:
    expect(texts('Он сказал: "первое. второе" — и ушёл.')).toEqual(['Он сказал: "первое. второе" — и ушёл.']);
    expect(texts('Он сказал: “первое. второе”. Дальше тишина.')).toEqual([
      'Он сказал: “первое. второе”.',
      'Дальше тишина.',
    ]);
    expect(texts('Он сказал: „первое. второе“. Дальше тишина.')).toEqual([
      'Он сказал: „первое. второе“.',
      'Дальше тишина.',
    ]);
    // An opener with no closer keeps the rest of the block inside it rather than guessing.
    expect(texts('Он начал: «первое. второе и всё.')).toEqual(['Он начал: «первое. второе и всё.']);
    // A closer that stands one space after the terminator still closes the quotation there: the
    // sentence ends at the terminal and the closer opens the next one (BOOK-68's fixture).
    expect(texts('Он сказал: «Уходи. » Потом закрыл дверь.')).toEqual([
      'Он сказал: «Уходи.',
      '» Потом закрыл дверь.',
    ]);
    // Prose after an internal full stop is not a closing quote: the quotation stays one sentence.
    expect(texts('Он прочёл: «Дело № 44/17. При себе иметь документ.» Дальше тишина.')).toEqual([
      'Он прочёл: «Дело № 44/17. При себе иметь документ.»',
      'Дальше тишина.',
    ]);
  });

  it('R3 keeps the closer with the sentence it closes, and splits after it', () => {
    const sentences = splitSentences('Потом спросил: «вы здесь?» Она кивнула.');
    expect(sentences.map((span) => span.text)).toEqual(['Потом спросил: «вы здесь?»', 'Она кивнула.']);
    // The closer belongs to the left sentence, not to the right one.
    expect(sentences[0]?.text.endsWith('»')).toBe(true);
    expect(sentences[1]?.text.startsWith('Она')).toBe(true);
    expect(texts('На обороте было написано: «Приходи один». Почерк был тот же.')).toEqual([
      'На обороте было написано: «Приходи один».',
      'Почерк был тот же.',
    ]);
  });

  it('R4 starts a sentence at a dialogue dash after a terminator, and nowhere else', () => {
    expect(texts('Он замолчал. — Слушаю, — сказала она.')).toEqual(['Он замолчал.', '— Слушаю, — сказала она.']);
    // A dash after a word is an apposition, not a speaker change.
    expect(texts('Это была не моя — а чужая записка.')).toEqual(['Это была не моя — а чужая записка.']);
  });

  it('R5 never terminates on an abbreviation, but closes a chain of them', () => {
    expect(texts('Пришли и т. д. Потом все ушли.')).toEqual(['Пришли и т. д.', 'Потом все ушли.']);
    // One abbreviation is not a chain: «1965 г. Он» stays whole (the ADR's own example).
    expect(texts('Акт от 14 сентября 1965 г. Он лежал на столе.')).toEqual([
      'Акт от 14 сентября 1965 г. Он лежал на столе.',
    ]);
    expect(texts('Это было до н. э. и после.')).toEqual(['Это было до н. э. и после.']);
    expect(texts('См. выше и стр. 4. Дальше тишина.')).toEqual(['См. выше и стр. 4.', 'Дальше тишина.']);
  });

  it('R6 keeps initials one token chain', () => {
    expect(texts('Подпись П. На обороте стояла дата.')).toEqual(['Подпись П. На обороте стояла дата.']);
    expect(texts('А. И. Пенькова подписала акт.')).toEqual(['А. И. Пенькова подписала акт.']);
    // ch11's commission survives as one sentence, initials and all.
    const sentences = texts(CH11);
    expect(sentences).toHaveLength(12);
    expect(sentences[3]).toBe('В нём значилась комиссия: «Бардин С. Л., Голованова Е. В., Пенькова Н. П.».');
    // «СССР.» is a word in capitals, not an initial: the full stop ends the sentence.
    expect(texts('Это было в СССР. Потом страна кончилась.')).toEqual(['Это было в СССР.', 'Потом страна кончилась.']);
  });

  it('R7 keeps a document number whole and splits after a plain number', () => {
    expect(texts('Дело № 44/17. При себе иметь документ.')).toEqual(['Дело № 44/17. При себе иметь документ.']);
    expect(texts('Приём в 13. Кабинет 7 был закрыт.')).toEqual(['Приём в 13.', 'Кабинет 7 был закрыт.']);
    expect(texts('Метка 4.5 и дата 21.10.2065 стояли рядом.')).toEqual([
      'Метка 4.5 и дата 21.10.2065 стояли рядом.',
    ]);
    // A number behind a marker of the set stays inside its reference («д. 14.»), and a plain
    // full stop before a number still ends the sentence.
    expect(texts('Он жил в д. 14. При себе иметь документ.')).toEqual([
      'Он жил в д. 14. При себе иметь документ.',
    ]);
    expect(texts('Он ушёл. 4 октября его не было.')).toEqual(['Он ушёл.', '4 октября его не было.']);
    // ch05's own paperwork: five sentences, and the quoted ruling is one of them.
    const ch05 = texts(CH05);
    expect(ch05).toHaveLength(5);
    expect(ch05[1]).toContain('№ 65/11432/вуч');
    expect(ch05[1]?.endsWith('Пункт 4».')).toBe(true);
  });

  it('R8 never terminates on a comma, decimal or otherwise', () => {
    expect(texts('Смешали 3,5 литра и оставили на ночь.')).toEqual(['Смешали 3,5 литра и оставили на ночь.']);
    expect(texts('Приём с 9 до 13, потом перерыв.')).toEqual(['Приём с 9 до 13, потом перерыв.']);
  });

  it('R9 never terminates on a semicolon', () => {
    const list = 'При себе иметь: документ, удостоверяющий личность; корешок уведомления; копию акта; всё остальное.';
    expect(texts(list)).toEqual([list]);
  });

  it('R10 keeps a lower-case continuation in the sentence before it', () => {
    expect(texts('Он спросил: «кто здесь?» — и сел у окна.')).toEqual(['Он спросил: «кто здесь?» — и сел у окна.']);
    expect(texts('Он молчал. а потом ушёл.')).toEqual(['Он молчал. а потом ушёл.']);
  });

  it('R11 makes the trailing fragment without a terminator the last sentence', () => {
    expect(texts('— Приходи один')).toEqual(['— Приходи один']);
    expect(texts('Первое. — Приходи один')).toEqual(['Первое.', '— Приходи один']);
    expect(texts('Конец.   ')).toEqual(['Конец.']);
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('')).toEqual([]);
    expect(texts('.')).toEqual(['.']);
  });

  it('R12 invents no boundary: a sentence over 600 characters stays one sentence', () => {
    const long = `${'слово '.repeat(120)}конец.`;
    expect(long.length).toBeGreaterThan(600);
    const sentences = splitSentences(long);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.text).toBe(long.trim());
    // The book's own long sentence: the ch08 letter is 709 code points and one sentence.
    expect(Array.from(CH08)).toHaveLength(709);
    expect(splitSentences(CH08)[0]?.text).toBe(CH08);
  });
});

describe('the shared segmenter is lossless and versioned', () => {
  it('reconstructs every paragraph from its spans and the whitespace between them', () => {
    for (const text of [CH12, CH08, CH05, CH11]) {
      let rebuilt = '';
      let at = 0;
      for (const span of splitSentences(text)) {
        const gap = Array.from(text).slice(at, span.start).join('');
        expect(gap.trim()).toBe('');
        rebuilt += gap + span.text;
        at = span.end;
      }
      rebuilt += Array.from(text).slice(at).join('');
      expect(rebuilt).toBe(text);
    }
  });

  it('speaks code points, so an emoji does not shift the offsets', () => {
    const text = 'Привет 🙂. Второе.';
    const spans = splitSentences(text);
    expect(spans.map((span) => [span.start, span.end])).toEqual([
      [0, 9],
      [10, 17],
    ]);
    expect(Array.from(text).slice(0, 9).join('')).toBe('Привет 🙂.');
    // The consumers that slice with `String#slice` convert: nine code points are ten UTF-16 units.
    expect(utf16Index(text, 0)).toBe(0);
    expect(utf16Index(text, 9)).toBe(10);
    expect(text.slice(utf16Index(text, 10), utf16Index(text, 17))).toBe('Второе.');
  });

  it('carries the version a stored partition was written with', () => {
    expect(SEGMENTER_VERSION).toBe(1);
  });
});

describe('the disagreement this module removes (BOOK-DOC-74 §1)', () => {
  it('reads the ch12 notice as 9 sentences where the naive split reads 13', () => {
    expect(naive(CH12)).toHaveLength(13);
    expect(texts(CH12)).toHaveLength(9);
    // The +44 % is four fragments of one quoted notice, every one of them anchorable before.
    expect(naive(CH12)[3]).toBe(
      'В тексте значилось: «Вам надлежит явиться в отдел учёта и регистрации для ознакомления с материалами дела № 44/17.',
    );
    expect(texts(CH12)[3]).toContain('Кабинет 7. Явиться без вызова повторно нельзя».');
  });
});
