import { CASCADE_MAX_WAVE, EDIT_MAX_CHARS, INTERVENTION_KIND_LIST } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CONSENT_COPY } from '../lib/consent.ts';
import { formatNumber } from '../lib/format.ts';
import baseCss from '../styles/base.css?raw';
import chromeCss from '../styles/chrome.css?raw';
import legalCss from '../styles/legal.css?raw';
import trailCss from '../styles/trail.css?raw';
import {
  MACHINE_TOOL_CAVEAT,
  MACHINE_TOOL_RULES,
  RIGHTS_ASSIGNMENT,
  RIGHTS_FALLBACK,
  RIGHTS_RETAINED,
  TERMS_VERSION,
  TOOL_CLAUSE,
} from '../lib/terms.ts';
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

describe('the way back (BOOK-221)', () => {
  for (const page of ['privacy', 'rules'] as const) {
    it(`opens /${page} with the one exit at its top, a real link to the book`, () => {
      const html = renderToStaticMarkup(<LegalPage page={page} />);
      // The column's first child, before the kicker and the title: the first stop in tab order.
      expect(html.startsWith('<main class="page legal"><p class="screen-exit"><a href="/#toc">к оглавлению</a></p>')).toBe(
        true,
      );
      expect(html.indexOf('class="screen-exit"')).toBeLessThan(html.indexOf('class="kicker"'));
      // The book is another document, so the href is absolute: the browser navigates and the
      // back button returns here. The copy is said once, in one place.
      expect(/href="([^"]+)"/u.exec(html)?.[1]).toBe('/#toc');
      expect(html.match(/к оглавлению/gu)).toHaveLength(1);
    });
  }
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
    const givenAt = text.indexOf('Что вы отдаёте');
    const boundsAt = text.indexOf('Сколько и как часто');
    const noteAt = text.indexOf('Если своего варианта нет');
    const refusedAt = text.indexOf('Что не принимается');
    expect(kindsAt).toBeGreaterThan(-1);
    expect(kindsAt).toBeLessThan(bringsAt);
    expect(bringsAt).toBeLessThan(givenAt);
    expect(givenAt).toBeLessThan(boundsAt);
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

  it('prints the licence word once, and only inside the fallback (BOOK-58 AC5)', () => {
    // The promise the site makes is an assignment; the word «неисключительн…» may appear once
    // on the page — in the sentence that saves the worst case (§7a) — and nowhere else.
    const occurrences = [...html.matchAll(/неисключительн/gu)];
    expect(occurrences).toHaveLength(1);
    const fallbackAt = html.indexOf(RIGHTS_FALLBACK);
    expect(fallbackAt).toBeGreaterThan(-1);
    const fallback = html.slice(fallbackAt, fallbackAt + RIGHTS_FALLBACK.length);
    expect(fallback).toContain('неисключительн');
    // Stronger than the stem: every «лиценз…» on the page — whatever the sentence around it —
    // sits inside the fallback. A new licence phrase anywhere else fails, not just this stem.
    const licenceAt = [...html.matchAll(/лиценз/giu)].map((match) => match.index ?? -1);
    expect(licenceAt.length).toBeGreaterThan(0);
    for (const at of licenceAt) {
      expect(at, `«лиценз» at ${String(at)} is outside the fallback`).toBeGreaterThanOrEqual(fallbackAt);
      expect(at).toBeLessThan(fallbackAt + RIGHTS_FALLBACK.length);
    }
    // And the assignment itself never says it: the right passes, it is not licensed.
    expect(RIGHTS_ASSIGNMENT).not.toMatch(/неисключительн|лиценз/u);
  });

  it('prints the grant and what stays as two sections, in that order (BOOK-72)', () => {
    // One heading used to carry both promises; now a reader reads the grant, then the list.
    expect(html).not.toContain('Что вы отдаёте и что остаётся вашим');
    const flat = text.replace(/\s+/gu, ' ');
    const givenAt = flat.indexOf('Что вы отдаёте');
    const keptAt = flat.indexOf('Что у вас остаётся');
    expect(givenAt).toBeGreaterThan(-1);
    expect(keptAt).toBeGreaterThan(-1);
    expect(givenAt).toBeLessThan(keptAt);
  });

  it('keeps the terms block in one order: assignment, fallback, tool clause, wave (BOOK-69)', () => {
    const flat = text.replace(/\s+/gu, ' ');
    const assignmentAt = flat.indexOf(RIGHTS_ASSIGNMENT);
    const fallbackAt = flat.indexOf(RIGHTS_FALLBACK);
    const toolAt = flat.indexOf(TOOL_CLAUSE);
    const waveAt = flat.indexOf('Следующая волна правок может эту фразу переписать или стереть');
    for (const at of [assignmentAt, fallbackAt, toolAt, waveAt]) expect(at).toBeGreaterThan(-1);
    expect(assignmentAt).toBeLessThan(fallbackAt);
    expect(fallbackAt).toBeLessThan(toolAt);
    expect(toolAt).toBeLessThan(waveAt);
    // No section boundary between the assignment and the tool clause: it is part of the terms,
    // not a footnote on another screen.
    const between = html.slice(html.indexOf(RIGHTS_ASSIGNMENT), html.indexOf(TOOL_CLAUSE));
    expect(between).not.toContain('</section>');
    expect(between).not.toContain('<h2');
  });

  it('prints what stays as a list of four items, one per promise (BOOK-72)', () => {
    expect(text.replace(/\s+/gu, ' ')).toContain('Что у вас остаётся');
    for (const line of RIGHTS_RETAINED) expect(html).toContain(`<li>${line}</li>`);
    // A list, not a paragraph: four items, and no fifth claim smuggled into the section.
    const keptSection = html.slice(html.indexOf('Что у вас остаётся'));
    const list = /<ul>([\s\S]*?)<\/ul>/u.exec(keptSection)?.[1] ?? '';
    expect([...list.matchAll(/<li>/gu)]).toHaveLength(4);
  });

  it('names who writes the book between the refusals and the chain that reads (BOOK-69)', () => {
    const flat = text.replace(/\s+/gu, ' ');
    expect(flat).toContain(MACHINE_TOOL_RULES);
    expect(flat).toContain(MACHINE_TOOL_CAVEAT);
    const refusedAt = flat.indexOf('Что не принимается');
    const writesAt = flat.indexOf('Кто пишет книгу');
    const readersAt = flat.indexOf('Кто читает текст');
    const worksAt = flat.indexOf('Как это работает');
    expect(refusedAt).toBeGreaterThan(-1);
    expect(refusedAt).toBeLessThan(writesAt);
    expect(writesAt).toBeLessThan(readersAt);
    // The chain of readers still sits before the mechanics, as it did before BOOK-69.
    expect(readersAt).toBeLessThan(worksAt);
  });

  it('states the bounds in one place: the length, one place, the day, the hour, the tries', () => {
    expect(text).toContain(`до ${formatNumber(EDIT_MAX_CHARS)} знаков`);
    expect(text).toContain('в одном месте');
    // BOOK-158: the daily edit is spent by an accepted filing; a refusal costs nothing.
    expect(text).toContain(
      'Правка дня — одна на читателя и на адрес — списывается только за принятое вмешательство: отказ её не тратит.',
    );
    expect(text).toContain(
      'Попытки ограничены: три на одно замечание в сутки, не чаще одной в десять минут, пять на читателя в сутки и пятнадцать на адрес в сутки.',
    );
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
    expect(text).toContain('указания машине');
    expect(text).toContain('глава 42 заморожена');
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

  // BOOK-126 — money, said once and plainly: a gift, buying nothing, with the bank running the
  // payment. It sits between the mechanics and the refusals, and it is copy, not a control.
  it('states the gift verbatim, once, before the refusals (BOOK-126)', () => {
    const flat = text.replace(/\s+/gu, ' ');
    const paragraph =
      'Деньги, которые приходят по ссылке «поддержать книгу», — подарок. Они ничего не оплачивают: ' +
      'ни доступа, ни глав, ни решений по правкам. Книга остаётся бесплатной, а правки идут по одной, ' +
      'в порядке записи.';
    expect(flat).toContain(paragraph);
    expect(flat).toContain('Платёж проводит банк: кто его сделал, мы не видим.');
    // One section, one print of the control's name.
    expect(flat.split('поддержать книгу')).toHaveLength(2);
    expect(flat).toContain('Деньги');
    // No pleading, no thanks, no sum, no goal — the copy the owner approved, and nothing else.
    expect(paragraph.replace(/\s+/gu, '')).not.toMatch(/\d/u);
    for (const word of ['спасибо', 'пожалуйста', 'пожертвование', 'подписка', 'цель']) {
      expect(flat.toLowerCase()).not.toContain(word);
    }
    // Placed after the mechanics and before the refusals.
    const moneyAt = flat.indexOf('Деньги');
    const boundsAt = flat.indexOf('Сколько и как часто');
    const refusedAt = flat.indexOf('Что не принимается');
    expect(moneyAt).toBeGreaterThan(boundsAt);
    expect(moneyAt).toBeLessThan(refusedAt);
  });

  // Audit M5 — the page is static: it fetches nothing and runs no third-party byte, so the
  // paragraph names the control instead of pointing at a link it cannot know is rendered.
  it('embeds no script, no iframe and no pixel (audit M5)', () => {
    for (const embedded of ['<script', '<iframe', '<img', 't.tb.ru', 'href="https://']) {
      expect(html, embedded).not.toContain(embedded);
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

/* ---------- the exit's face, resolved from the sheets (BOOK-221) ---------- */

/**
 * `.legal p` (0,1,1) out-specifies a bare class and `legal.css` boots after `chrome.css`, so a
 * markup assertion cannot see that `/rules` painted the exit at serif 18. These tests resolve the
 * cascade of the real sheets for the element itself: the declarations are read from the file
 * text, specificity is counted the way the cascade counts it, and the winning rule is named.
 * `@media` blocks are skipped — the exit's face is a base rule, and a narrower step that changed
 * it is a line the browser harness (`line:fonts`) measures.
 */

type CssNode = { tag: string; classes: readonly string[] };
type Compound = { tag: string | null; classes: string[] };
type Selector = { compounds: Compound[]; combinators: string[] };
type Won = { value: string; selector: string };

/** `.legal > p.screen-exit` as compounds and the combinators between them. A tag, `.classes` or
 *  `*` — an attribute or a pseudo selector is not one this reader understands, so such a rule is
 *  dropped; none of these four sheets needs one here. */
function parseSelector(text: string): Selector | null {
  const compounds: Compound[] = [];
  const combinators: string[] = [];
  for (const token of text.replace(/\s*>\s*/gu, ' > ').trim().split(/\s+/u)) {
    if (token === '>') {
      if (compounds.length === 0) return null;
      combinators[compounds.length - 1] = '>';
      continue;
    }
    const match = /^(\*|[a-z][a-z0-9-]*)?((?:\.[a-z0-9-]+)*)$/u.exec(token);
    if (match === null) return null;
    compounds.push({
      tag: match[1] === undefined || match[1] === '*' ? null : match[1],
      classes: [...(match[2] ?? '').matchAll(/\.([a-z0-9-]+)/gu)].map((one) => one[1] ?? ''),
    });
  }
  for (let index = 0; index < compounds.length - 1; index += 1) combinators[index] ??= ' ';
  return compounds.length === 0 ? null : { compounds, combinators };
}

function matchesFrom(selector: Selector, path: readonly CssNode[], at: number, depth: number): boolean {
  if (depth < 0) return true;
  if (at < 0) return false;
  const compound = selector.compounds[depth] as Compound;
  const node = path[at] as CssNode;
  if (compound.tag !== null && compound.tag !== node.tag) return false;
  if (!compound.classes.every((name) => node.classes.includes(name))) return false;
  if (depth === 0) return true;
  if (selector.combinators[depth - 1] === '>') return matchesFrom(selector, path, at - 1, depth - 1);
  for (let before = at - 1; before >= 0; before -= 1) {
    if (matchesFrom(selector, path, before, depth - 1)) return true;
  }
  return false;
}

function outranks(left: number[], right: number[]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Every property that lands on `path`, at the declaration that actually wins it. */
function cascade(path: readonly CssNode[], ignore?: string): Map<string, Won> {
  const rules: Array<{ selector: string; parsed: Selector; body: string; order: number }> = [];
  for (const sheet of [baseCss, chromeCss, legalCss, trailCss]) {
    let bare = sheet.replace(/\/\*[\s\S]*?\*\//gu, '');
    while (bare.includes('@media')) {
      const at = bare.indexOf('@media');
      let depth = 0;
      let cursor = bare.indexOf('{', at);
      for (; cursor < bare.length; cursor += 1) {
        if (bare[cursor] === '{') depth += 1;
        if (bare[cursor] === '}') depth -= 1;
        if (depth === 0) break;
      }
      bare = `${bare.slice(0, at)}${bare.slice(cursor + 1)}`;
    }
    for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      for (const text of (match[1] ?? '').split(',')) {
        const parsed = parseSelector(text.trim());
        if (parsed !== null) {
          rules.push({ selector: text.trim(), parsed, body: match[2] ?? '', order: rules.length });
        }
      }
    }
  }
  const won = new Map<string, Won>();
  const rank = new Map<string, number[]>();
  for (const rule of rules) {
    if (rule.selector === ignore) continue;
    if (!matchesFrom(rule.parsed, path, path.length - 1, rule.parsed.compounds.length - 1)) continue;
    let classes = 0;
    let tags = 0;
    for (const compound of rule.parsed.compounds) {
      classes += compound.classes.length;
      if (compound.tag !== null) tags += 1;
    }
    // `[ids, classes, tags, order]` — the cascade's own comparison, and these sheets carry no ids.
    const weight = [0, classes, tags, rule.order];
    for (const declaration of rule.body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/gu)) {
      const property = declaration[1] ?? '';
      const held = rank.get(property);
      if (held !== undefined && !outranks(weight, held)) continue;
      rank.set(property, weight);
      won.set(property, { value: (declaration[2] ?? '').trim(), selector: rule.selector });
    }
  }
  return won;
}

/** The exit's own path: the column it stands in (`main.page.legal` or the trail's section), the
 *  line, and — when asked for — the link inside it. */
function exitPath(inDocument: boolean, link = false): CssNode[] {
  const column: CssNode = inDocument
    ? { tag: 'main', classes: ['page', 'legal'] }
    : { tag: 'section', classes: ['page', 'sheet', 'sled'] };
  const path: CssNode[] = [
    { tag: 'html', classes: [] },
    { tag: 'body', classes: [] },
    { tag: 'div', classes: ['canvas'] },
    column,
    { tag: 'p', classes: ['screen-exit'] },
  ];
  return link ? [...path, { tag: 'a', classes: [] }] : path;
}

describe('the exit’s face, taken from the sheets (BOOK-221)', () => {
  it('wins on the static documents and on the trail: mono 12, the quiet ink, no underline', () => {
    for (const [where, inDocument] of [
      ['/privacy and /rules', true],
      ['the trail', false],
    ] as const) {
      const line = cascade(exitPath(inDocument));
      expect(line.get('font-family')?.value, `${where}: face`).toBe('var(--mono)');
      expect(line.get('font-size')?.value, `${where}: size`).toBe('var(--fs-micro)');
      // One line of movement at most: the margin stays inside the 1.35 line box.
      expect(line.get('margin')?.value, `${where}: margin`).toBe('0 0 4px');
      const anchor = cascade(exitPath(inDocument, true));
      expect(anchor.get('color')?.value, `${where}: ink`).toBe('var(--ink-3)');
      expect(anchor.get('text-decoration')?.value, `${where}: no underline`).toBe('none');
      // No second face or size on the line: the link declares neither and inherits the `p`'s.
      expect(anchor.get('font-family'), `${where}: one face`).toBeUndefined();
      expect(anchor.get('font-size'), `${where}: one size`).toBeUndefined();
    }
  });

  it('names the selector that beats `.legal p` — and loses the face without it', () => {
    // The reviewed defect: the document's paragraph rule really does declare serif at the body
    // size, so the second selector is the whole reason the exit is mono. Drop it and the cascade
    // lands on `.legal p` — the failure this pin exists to catch.
    expect(cascade(exitPath(true)).get('font-size')?.selector).toBe('.legal .screen-exit');
    const unguarded = cascade(exitPath(true), '.legal .screen-exit');
    expect(unguarded.get('font-family')).toEqual({ value: 'var(--serif)', selector: '.legal p' });
    expect(unguarded.get('font-size')).toEqual({ value: 'var(--fs-body)', selector: '.legal p' });
  });
});
