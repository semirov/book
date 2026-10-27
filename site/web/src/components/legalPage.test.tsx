import { CASCADE_MAX_WAVE, EDIT_MAX_CHARS, INTERVENTION_KIND_LIST } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CONSENT_COPY } from '../lib/consent.ts';
import { formatNumber } from '../lib/format.ts';
import { RIGHTS_ASSIGNMENT, RIGHTS_FALLBACK, TERMS_VERSION } from '../lib/terms.ts';
import { LegalPage } from './LegalPage.tsx';

/**
 * The static documents (audit M5) must name every third-party surface, say what each can see,
 * say what a reader can do about it, and (BOOK-64) promise no challenge that does not run.
 */
describe('/privacy', () => {
  const html = renderToStaticMarkup(<LegalPage page="privacy" />);

  it('promises no challenge: no widget, no provider, no Turnstile (BOOK-64)', () => {
    expect(html).not.toContain('Проверка «я не робот»');
    expect(html).not.toContain('Turnstile');
    expect(html).not.toContain('hCaptcha');
    expect(html).not.toContain('CAPTCHA');
    // What is true instead: the counter, the comment, and the limits around writing.
    expect(html).toContain('счётчик посещений');
    expect(html).toContain('10 замечаний в час');
    expect(html).toContain('одна правка в сутки');
  });

  it('names the Metrika counter, its cookies and the way to avoid it', () => {
    expect(html).toContain('mc.yandex.ru');
    expect(html).toContain('_ym_');
    expect(html).toContain('блокировщик рекламы');
    expect(html).toContain('Как обойтись без этого');
  });

  it('carries the legal researcher’s Metrika paragraph verbatim (BOOK-63)', () => {
    const text = html.replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim();
    const paragraph =
      'Мы включили Яндекс Метрику — счётчик посещаемости. С вашего согласия он отправляет в Яндекс то, что видит браузер: адрес страницы, откуда вы пришли, устройство, экран, IP-адрес и свои cookie _ym_*. Пол, возраст и интересы Метрика достраивает по данным Яндекса. Нужно, чтобы понимать, какие главы читают. Ваш текст, имя и номер читателя в счётчик не попадают никогда: в событиях только названия действий и номера глав. Данные хранит Яндекс в России, пока счётчик работает. Отказаться: расширение «Блокировщик Яндекс.Метрики» или запрет сторонних cookie в браузере — книга читается без счётчика.';
    expect(text).toContain(paragraph);
    expect(paragraph.split(/\s+/u)).toHaveLength(87);
  });

  it('keeps the lead as the page’s prose, not the cover’s pull quote (BOOK-92)', () => {
    // The cover's `p.premise` was a centred 26ch quote; the legal lead has a class of its own.
    expect(html).toContain('class="legal-lead"');
    expect(html).not.toContain('class="premise"');
  });

  it('keeps the consent line on /privacy, with the place to change the choice', () => {
    expect(html).toContain(CONSENT_COPY);
    expect(html).toContain('Разрешить');
    expect(html).toContain('Только необходимое');
    expect(html).toContain('сейчас: выключена');
  });

  it('states what the site stores itself and links to the rules and the book', () => {
    expect(html).toContain('SHA-256');
    expect(html).toContain('10 замечаний в час');
    expect(html).toContain('href="/rules"');
    expect(html).toContain('href="/"');
  });

  it('names the reader’s shown name, and says history is not open yet (BOOK-56, BOOK-59)', () => {
    // Contributors print their shown name, not a hash: the page must not promise anonymity.
    expect(html).toContain('показывается своим показанным именем, а не внутренним номером');
    expect(html).not.toContain('псевдонимом-хешем');
    // The chronicle wakes with the first reader edit; today the page says so instead of
    // promising a surface that is not there.
    expect(html).toContain('её история станет частью книги с первой читательской правкой');
    expect(html).not.toContain('вся история книги работают без CAPTCHA');
  });
});

describe('/rules', () => {
  const html = renderToStaticMarkup(<LegalPage page="rules" />);
  // Read as a reader reads it: tags stripped, so a class name cannot satisfy a copy assertion.
  const text = html.replace(/<[^>]*>/gu, ' ');
  const heading = /<h1 class="title">([\s\S]*?)<\/h1>/u.exec(html)?.[1] ?? '';

  it('sets the lead as prose in the column, not as the cover’s quote (BOOK-92)', () => {
    expect(html).toContain('class="legal-lead"');
    expect(html).not.toContain('class="premise"');
  });

  it('opens on the intervention, not on a note about the text (BOOK-22)', () => {
    expect(heading.toLowerCase()).toContain('вмешательство');
    expect(heading.toLowerCase()).not.toContain('замечан');
    // The first screen says what it is: a world-fact of one of four kinds, judged against the book.
    expect(text).toContain(`один из четырёх: ${INTERVENTION_KIND_LIST}`);
    expect(text).toContain('Сначала проверяют, укладывается ли это в книгу');
    expect(text.toLowerCase()).toContain('факт мира');
  });

  it('names the canvas the fit test is measured against (BOOK-DOC-4 rule 6)', () => {
    // «Укладывается» is not a verdict a reader can guess: the page says what the book is.
    expect(text).toContain('тоска, холод, процедура вместо чуда, без утешения');
  });

  it('defines the intervention once and puts it before the note', () => {
    // One definition on one screen: the premise carries it, the section below does not repeat it.
    expect(text.split('факт мира')).toHaveLength(2);
    expect(text).toContain('Что вы вносите');
    expect(text).not.toContain('Что принимается');
    expect(text).toContain('Писатель берёт идею, а не байты');
    const kindsAt = text.indexOf(INTERVENTION_KIND_LIST);
    const bringsAt = text.indexOf('Что вы вносите');
    const boundsAt = text.indexOf('Сколько и как часто');
    const noteAt = text.indexOf('Если своего варианта нет');
    const refusedAt = text.indexOf('Что не принимается');
    expect(kindsAt).toBeGreaterThan(-1);
    expect(kindsAt).toBeLessThan(bringsAt);
    expect(bringsAt).toBeLessThan(boundsAt);
    expect(boundsAt).toBeLessThan(noteAt);
    expect(noteAt).toBeLessThan(refusedAt);
  });

  it('states the assignment, once, in the reader’s own words (BOOK-58)', () => {
    // BOOK-58: the right in an accepted variant passes in full and free of charge; authorship
    // and the name cannot pass at all, and a later wave may rewrite or erase the phrase.
    expect(text).toContain(RIGHTS_ASSIGNMENT);
    expect(text).toContain(RIGHTS_FALLBACK);
    // The paragraph says which terms it is; a later acceptance record can name the same version.
    expect(html).toContain(`data-terms="${TERMS_VERSION}"`);
    expect(text).not.toContain('вы даёте проекту неисключительную лицензию');
    expect(text).toContain('Авторство, имя и защита от искажения остаются у вас');
    expect(text).toContain('переписать или стереть');
    expect(text).toContain('Свою долю в окончательном тексте');
  });

  it('states the bounds in one place: the length, one place, the day, the hour', () => {
    expect(text).toContain(`до ${formatNumber(EDIT_MAX_CHARS)} знаков`);
    expect(text).toContain('в одном месте');
    // BOOK-DOC-4 rule 5: both counters are named, reader and address.
    expect(text).toContain('одна правка в сутки на читателя и на адрес');
    expect(text).toContain('не больше 10 в час с одного адреса и с одного читателя');
  });

  it('keeps the secondary path — a note without a type is not an intervention (BOOK-57)', () => {
    // A note is read, but it writes nothing, waves nowhere and does not spend the day's edit.
    expect(text).toContain(
      'Замечание без типа — не вмешательство: его читают, но оно ничего не вносит, не расходится волной и не тратит правку дня.',
    );
    expect(text).not.toContain('в очередь правок оно не встаёт');
  });

  it('keeps the frozen ending and the promise that a refusal has a public reason', () => {
    expect(text).toContain('реальные люди');
    expect(text).toContain('указания модели');
    expect(text).toContain('глава 67 заморожена');
    expect(text).toContain('публичной причиной');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/"');
  });

  it('promises one wave, both directions, and a second one only by decision (BOOK-59)', () => {
    // The constant the config and the `hello` limit are pinned to is one; the copy follows it
    // without printing a number, because «волна 1 / 1» says nothing.
    expect(CASCADE_MAX_WAVE).toBe(1);
    expect(text).toContain(
      'правка расходится одной волной по соседним главам — вперёд и назад; вторая волна бывает только решением владельца',
    );
    expect(text).not.toContain('5 волн');
    expect(text).not.toContain('из 5');
    expect(text).not.toContain('волн, глубже');
  });

  it('says none of the internal words to a reader (BOOK-22)', () => {
    const markup = text.toLowerCase();
    // BOOK-76 dropped the ban on «аудитор»: the reader is now told the chain that reads the
    // text, and the auditor is one of its steps. The gate vocabulary stays internal.
    for (const word of ['fits', 'off', 'auditor', 'шов', 'противоречие исправлено', 'битый', '!', 'вердикт', 'findings', 'holds', 'gap', 'gate', 'blocker']) {
      expect(markup).not.toContain(word);
    }
  });

  it('names the chain that reads the text, between the refusals and the mechanics (BOOK-76)', () => {
    const flat = text.replace(/\s+/gu, ' ');
    expect(flat).toContain('Кто читает текст');
    expect(flat).toContain('научный консультант');
    expect(flat).toContain('Не проходит проверку — в книгу не входит');
    // The section sits where a reader looks for the rule, not appended at the end.
    const refusedAt = text.indexOf('Что не принимается');
    const readersAt = text.indexOf('Кто читает текст');
    const worksAt = text.indexOf('Как это работает');
    expect(refusedAt).toBeGreaterThan(-1);
    expect(readersAt).toBeGreaterThan(refusedAt);
    expect(readersAt).toBeLessThan(worksAt);
  });
});
