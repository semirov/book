import { CASCADE_MAX_WAVE, EDIT_MAX_CHARS, INTERVENTION_KIND_LIST } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { formatNumber } from '../lib/format.ts';
import { LegalPage } from './LegalPage.tsx';

/**
 * The static documents (audit M5) must name the two third-party surfaces, say what each can
 * see, and say what a reader can do about it — in that order, and without a counter of ours.
 */
describe('/privacy', () => {
  const html = renderToStaticMarkup(<LegalPage page="privacy" />);

  it('names the CAPTCHA, what it sees, and that the comment body never reaches it', () => {
    expect(html).toContain('Проверка «я не робот»');
    expect(html).toContain('Turnstile');
    expect(html).toContain('hCaptcha');
    expect(html).toContain('IP-адрес');
    expect(html).toContain('не видит текст');
  });

  it('names the Metrika counter, its cookies and the way to avoid it', () => {
    expect(html).toContain('mc.yandex.ru');
    expect(html).toContain('_ym_');
    expect(html).toContain('блокировщик рекламы');
    expect(html).toContain('Как обойтись без этого');
  });

  it('states what the site stores itself and links to the rules and the book', () => {
    expect(html).toContain('SHA-256');
    expect(html).toContain('10 замечаний в час');
    expect(html).toContain('href="/rules"');
    expect(html).toContain('href="/"');
  });
});

describe('/rules', () => {
  const html = renderToStaticMarkup(<LegalPage page="rules" />);
  // Read as a reader reads it: tags stripped, so a class name cannot satisfy a copy assertion.
  const text = html.replace(/<[^>]*>/gu, ' ');
  const heading = /<h1 class="title">([\s\S]*?)<\/h1>/u.exec(html)?.[1] ?? '';

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

  it('states the bounds in one place: the length, one place, the day, the hour', () => {
    expect(text).toContain(`до ${formatNumber(EDIT_MAX_CHARS)} знаков`);
    expect(text).toContain('в одном месте');
    // BOOK-DOC-4 rule 5: both counters are named, reader and address.
    expect(text).toContain('одна правка в сутки на читателя и на адрес');
    expect(text).toContain('не больше 10 в час с одного адреса и с одного читателя');
  });

  it('keeps the secondary path — a note without one’s own wording is feedback about the text', () => {
    expect(text).toContain('Замечание без своего варианта — отзыв о тексте: тип у него не спрашивают.');
    // It is still taken in; only the kind is not asked. The page must not promise otherwise.
    expect(text).not.toContain('в очередь правок оно не встаёт');
  });

  it('keeps the frozen ending and the promise that a refusal has a public reason', () => {
    expect(text).toContain('реальные люди');
    expect(text).toContain('указания модели');
    expect(text).toContain(`до ${CASCADE_MAX_WAVE} волн`);
    expect(text).toContain('глава 67 заморожена');
    expect(text).toContain('публичной причиной');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/"');
  });

  it('says none of the internal words to a reader (BOOK-22)', () => {
    const markup = text.toLowerCase();
    for (const word of ['fits', 'off', 'auditor', 'аудитор', 'шов', 'противоречие исправлено', 'битый', '!']) {
      expect(markup).not.toContain(word);
    }
  });
});
