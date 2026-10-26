import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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

  it('says what is accepted and what is refused, with the limits', () => {
    expect(html).toContain('одна правка в сутки');
    expect(html).toContain('10 замечаний в час');
    expect(html).toContain('реальные люди');
    expect(html).toContain('указания модели');
  });

  it('keeps the frozen ending and the promise that a refusal has a public reason', () => {
    expect(html).toContain('глава 67 заморожена');
    expect(html).toContain('публичной причиной');
    expect(html).toContain('href="/privacy"');
  });
});
