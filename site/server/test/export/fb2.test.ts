// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { COVER_ID, COVER_TYPE } from '../../src/fb2/cover.ts';
import { esc, exportMoment, renderFb2, type Fb2Input } from '../../src/fb2/serialize.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { boundaryLabel } from '../../../web/src/lib/changeStatus.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';

/**
 * BOOK-60 / BOOK-DOC-41 — the file itself: schema order, the annotation, every section, total
 * escaping, and the empty book. BOOK-133 adds the cover: the `coverpage` reference and the
 * one `binary` that closes the document, bound to the real asset in `web/public/cover`.
 * The assertions run on a real `GET /book.fb2` parsed as XML (jsdom), not on serializer
 * internals: the contract is the document a reader opens.
 */

/** `site/server/test/export` → `site/`. */
const COVER_SOURCE = resolve(import.meta.dirname, '..', '..', '..', 'web', 'public', 'cover', 'cover.png');
const COVER_SHA256 = '9491eb0b5b5832950352899c72b1e4bc5c51ed52731836bbcdab27c02e695c94';

const ABOUT_PARAGRAPHS = [
  'Материя заметила себя, когда в ней замкнулась петля: состояние, память, предсказание.',
  'Это не пробуждение. Просто однажды описание перестало быть внешним.',
  'Наблюдатель был сделан из того же, что и наблюдаемое, — и полной картины не получилось.',
  'Знание перебралось туда, где дешевле: углерод думал телом, кремний — копированием.',
  'У этого была цена: когда решение можно перепоручить, человек перестаёт начинать с нуля.',
  'Ошибка перестала быть локальной: она повторялась быстрее, чем её успевали понять.',
  'Космос не приходил откровением. Он приходил очередью, реестром, датчиком, бланком.',
  'Свет — последний предел. Путь к точке не выбирают.',
  'Конец не объявляют. Его подписывают.',
];
const FRONT = `Бланк\n\n${ABOUT_PARAGRAPHS.join('\n\n')}\n`;
const CHAPTER_TITLE = 'Название главы';
// The second paragraph is hard-wrapped in the source: the file collapses the line break (§3).
const CHAPTER_SEVEN = longProse(['Первый абзац\nседьмой главы.'], CHAPTER_TITLE);
/** Markup-shaped characters are prose here: the escaper is what keeps the file well-formed. */
const NASTY = 'Комментарий <b>&]]> — проверка экранирования.';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boot(chapters: Record<string, string> = {}, now?: () => Date): Promise<Fixture> {
  fixture = createFixture(chapters);
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const webDist = join(fixture.dataDir, 'web');
  mkdirSync(webDist, { recursive: true });
  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: webDist,
      PORT: '8080',
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    ...(now === undefined ? {} : { now }),
  });
  return fixture;
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

/** The response parsed as XML; a `parsererror` fails the test with the file's own complaint. */
function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  expect(error?.textContent ?? null).toBeNull();
  return doc;
}

function textOf(element: Element | undefined): string {
  return element?.textContent ?? '';
}

/** Child element names in document order — the schema's order is what the XSD rejects. */
function childNames(element: Element): string[] {
  return [...element.children].map((child) => child.nodeName);
}

const BASE: Fb2Input = {
  title: null,
  about: null,
  author: 'Филипп Семиров',
  year: 'auto',
  version: 'test',
  srcUrl: 'https://book.semirov.dev/',
  revision: 42,
  chapters: [],
  // The renderer is pure: these bytes are a placeholder, and only the serializer tests use them.
  cover: { id: COVER_ID, contentType: COVER_TYPE, base64: 'ZmFrZQ==' },
};

describe('the FB2 file (BOOK-60)', () => {
  it('AC1 — a valid file: description in schema order, the nine-paragraph annotation, every section in order', async () => {
    await boot({
      '00-front.md': FRONT,
      'ch01.md': FRAME_FIRST_SENTENCE,
      'ch07.md': CHAPTER_SEVEN,
      'ch42.md': FRAME_LAST_SENTENCE,
    });
    const response = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(response.statusCode).toBe(200);

    const doc = parseXml(response.body);
    const root = doc.documentElement;
    expect(root.nodeName).toBe('FictionBook');
    expect(root.getAttribute('xmlns')).toBe('http://www.gribuser.ru/xml/fictionbook/2.0');

    const description = root.getElementsByTagName('description')[0]!;
    expect(childNames(description)).toEqual(['title-info', 'document-info']);

    const titleInfo = description.getElementsByTagName('title-info')[0]!;
    // imprint.year is "auto", so title-info/date is omitted, not invented (§3); the cover
    // reference sits in the schema's slot — after date, before lang (BOOK-133).
    expect(childNames(titleInfo)).toEqual(['genre', 'author', 'book-title', 'annotation', 'coverpage', 'lang']);
    expect(textOf(titleInfo.getElementsByTagName('genre')[0])).toBe('sf');
    expect(textOf(titleInfo.getElementsByTagName('nickname')[0])).toBe('Филипп Семиров');
    expect(textOf(titleInfo.getElementsByTagName('book-title')[0])).toBe('Бланк');
    expect(textOf(titleInfo.getElementsByTagName('lang')[0])).toBe('ru');
    const annotation = titleInfo.getElementsByTagName('annotation')[0]!;
    expect([...annotation.getElementsByTagName('p')].map((p) => p.textContent)).toEqual(ABOUT_PARAGRAPHS);

    const documentInfo = description.getElementsByTagName('document-info')[0]!;
    expect(childNames(documentInfo)).toEqual(['author', 'program-used', 'date', 'src-url', 'id', 'version']);
    expect(textOf(documentInfo.getElementsByTagName('nickname')[0])).toBe('Филипп Семиров');
    expect(textOf(documentInfo.getElementsByTagName('program-used')[0])).toBe('book-site test');
    expect(textOf(documentInfo.getElementsByTagName('src-url')[0])).toBe('https://book.semirov.dev/');
    expect(textOf(documentInfo.getElementsByTagName('id')[0])).toBe('urn:book:blank');
    expect(textOf(documentInfo.getElementsByTagName('version')[0])).toMatch(/^\d+$/u);
    // The XSD types `date`'s value as xs:date: the local day, never the time.
    expect(documentInfo.getElementsByTagName('date')[0]!.getAttribute('value')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    const sections = [...root.getElementsByTagName('body')[0]!.children];
    expect(sections).toHaveLength(TOTAL_CHAPTERS);
    expect(sections.map((section) => section.getAttribute('id'))).toEqual(
      Array.from({ length: TOTAL_CHAPTERS }, (_, index) => `ch${String(index + 1).padStart(2, '0')}`),
    );
    sections.forEach((section, index) => {
      const titleParagraphs = [...section.getElementsByTagName('title')[0]!.children];
      expect(titleParagraphs[0]!.textContent, section.getAttribute('id') ?? '').toBe(`Глава ${index + 1}`);
    });

    // A written chapter: «Глава 7», then its own title, then its prose.
    const seventh = sections[6]!;
    expect([...seventh.getElementsByTagName('title')[0]!.children].map((p) => p.textContent)).toEqual([
      'Глава 7',
      CHAPTER_TITLE,
    ]);
    expect([...seventh.children].filter((child) => child.nodeName === 'p')[0]!.textContent).toBe(
      'Первый абзац седьмой главы.',
    );

    // A basis-only slot carries its one paragraph as prose, never `<empty-line/>` (BOOK-6).
    const first = sections[0]!;
    expect([...first.getElementsByTagName('p')].map((p) => p.textContent)).toEqual([
      'Глава 1',
      FRAME_FIRST_SENTENCE,
    ]);
    expect(first.getElementsByTagName('empty-line')).toHaveLength(0);

    // An absent slot is a titled section and nothing else.
    const second = sections[1]!;
    expect(second.getElementsByTagName('empty-line')).toHaveLength(1);
    expect([...second.getElementsByTagName('p')].map((p) => p.textContent)).toEqual(['Глава 2']);
  });

  it('AC5 — escaping is total and the file is only the manuscript: `<b>&]]>` survives, and no web copy, seam numeral or history line appears', async () => {
    await boot({ 'ch08.md': longProse([NASTY], 'Глава с разметкой') });
    const response = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(response.statusCode).toBe(200);

    // The document still parses, and the characters arrive as text — not as elements.
    const doc = parseXml(response.body);
    const allText = doc.documentElement.textContent ?? '';
    expect(allText).toContain(NASTY);

    // The web's own explanation and the title sheet's copy are not manuscript text (§3).
    const components = resolve(import.meta.dirname, '..', '..', '..', 'web', 'src', 'components');
    const webSource = (path: string): string => readFileSync(join(components, path), 'utf8');
    const longStrings = (source: string): string[] =>
      [...source.matchAll(/'([^'\\\n]{30,})'/gu)].map((match) => match[1] ?? '');
    for (const copy of [...longStrings(webSource('HowTheBookIsMade.tsx')), ...longStrings(webSource('TitleSheet.tsx'))]) {
      expect(allText).not.toContain(copy);
    }

    // The seam's states and the chronicle's lines have no path into the serializer's input.
    // Every ban below is a string the app really prints, taken from its own source or its own
    // function — a ban on a phrase nothing can produce would be decoration, not a gate.
    // BOOK-167: the chapter's prose moved into `ChapterProse.tsx`; the seam's copy lives there
    // now, so the ban reads both files and still names a string the app really prints.
    const chapterArticle = `${webSource('ChapterArticle.tsx')}\n${webSource('ChapterProse.tsx')}`;
    const seamCopy = [...chapterArticle.matchAll(/'(правится[^']*)'/gu)].map((match) => match[1] ?? '');
    expect(seamCopy.length, 'the seam copy is still in the chapter’s prose').toBeGreaterThan(0);
    for (const banned of [
      boundaryLabel(35),
      boundaryLabel('front'),
      // changeStatus.ts:107 — the lane's own line while a chapter is being written.
      'пишется глава',
      // Chronicle.tsx — the history surface's name.
      'хроника книги',
      ...seamCopy,
    ]) {
      expect(allText, banned).not.toContain(banned);
    }
  });

  it('AC6 — an empty book exports a readable description and every section titled and empty', async () => {
    await boot();
    const response = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(response.statusCode).toBe(200);

    const doc = parseXml(response.body);
    const titleInfo = doc.getElementsByTagName('title-info')[0]!;
    expect(textOf(titleInfo.getElementsByTagName('book-title')[0])).toBe('Книга');
    expect(titleInfo.getElementsByTagName('annotation')).toHaveLength(0);

    const sections = [...doc.getElementsByTagName('body')[0]!.children];
    expect(sections).toHaveLength(TOTAL_CHAPTERS);
    sections.forEach((section, index) => {
      const paragraphs = [...section.getElementsByTagName('p')].map((p) => p.textContent);
      expect(paragraphs).toEqual([`Глава ${index + 1}`]);
      expect(section.getElementsByTagName('empty-line'), section.getAttribute('id') ?? '').toHaveLength(1);
    });
    expect(textOf(doc.getElementsByTagName('version')[0])).toMatch(/^\d+$/u);
  });

  it('omits the annotation when the front matter has no page 2 (BOOK-DOC-41 §3)', () => {
    const { head, tail } = renderFb2(BASE);
    const doc = parseXml(`${head}\n   <date value="2026-10-27">2026-10-27T14:03:12+03:00</date>${tail}`);
    expect(doc.getElementsByTagName('annotation')).toHaveLength(0);
    expect(textOf(doc.getElementsByTagName('book-title')[0])).toBe('Книга');
  });

  it('renders title-info/date only for a four-digit imprint year, before the cover and lang (BOOK-DOC-41 §3)', () => {
    // `imprint.year` is "auto" today: the date is omitted rather than invented.
    expect(renderFb2(BASE).head).not.toContain('<date>20');
    const head = renderFb2({ ...BASE, year: '2026' }).head;
    expect(head).toContain('<date>2026</date>');
    // The XSD's order: date, then coverpage, then lang (BOOK-133).
    expect(head.indexOf('<date>2026</date>')).toBeLessThan(head.indexOf('<coverpage>'));
    expect(head.indexOf('<coverpage>')).toBeLessThan(head.indexOf('<lang>ru</lang>'));
  });

  it('treats a blank annotation and an empty chapter title as absent (BOOK-DOC-41 §3)', () => {
    const { head, tail } = renderFb2({
      ...BASE,
      about: '   ',
      chapters: [{ n: 3, title: '', paragraphs: [] }],
    });
    expect(head).not.toContain('<annotation>');
    expect(tail).toContain('<section id="ch03"><title><p>Глава 3</p></title><empty-line/></section>');
  });
});

describe('the cover inside the file (BOOK-133)', () => {
  /** The document's one `binary`, decoded: whitespace between the base64 lines is not data. */
  function binaryBytes(doc: Document): Buffer {
    const binaries = doc.getElementsByTagName('binary');
    expect(binaries).toHaveLength(1);
    return Buffer.from(binaries[0]!.textContent!.replace(/\s+/gu, ''), 'base64');
  }

  it('cover — `coverpage` sits in `title-info` and references `#cover.png`, the id that exists exactly once', async () => {
    await boot({ 'ch01.md': FRAME_FIRST_SENTENCE });
    const response = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(response.statusCode).toBe(200);

    const doc = parseXml(response.body);
    const titleInfo = doc.getElementsByTagName('title-info')[0]!;
    const coverpage = titleInfo.getElementsByTagName('coverpage')[0]!;
    expect(coverpage.parentElement!.nodeName).toBe('title-info');
    const image = coverpage.getElementsByTagName('image')[0]!;
    // The prefix `l` is the XLink namespace: a document that names it without declaring it
    // is not namespace-well-formed, which is why the root carries the declaration.
    expect(image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#cover.png');

    const binaries = doc.getElementsByTagName('binary');
    expect(binaries).toHaveLength(1);
    expect(binaries[0]!.getAttribute('id')).toBe('cover.png');
    expect(binaries[0]!.getAttribute('content-type')).toBe('image/png');
    // One id under the whole document: no second element answers to it.
    expect(doc.querySelectorAll('[id="cover.png"]')).toHaveLength(1);
  });

  it('cover — the single `<binary>` is the last element of the document and decodes to the exact source bytes (length + sha256)', async () => {
    await boot({ 'ch01.md': FRAME_FIRST_SENTENCE });
    const response = await app!.inject({ method: 'GET', url: '/book.fb2' });
    const doc = parseXml(response.body);
    const root = doc.documentElement;
    expect(root.children[root.children.length - 1]!.nodeName).toBe('binary');

    const embedded = binaryBytes(doc);
    expect(embedded.length).toBe(1_108_247);
    expect(createHash('sha256').update(embedded).digest('hex')).toBe(COVER_SHA256);
    expect(Buffer.compare(embedded, readFileSync(COVER_SOURCE))).toBe(0);
    // Wrapped at 78 characters, LF only: a CR would move the bytes a reader decodes.
    const base64Text = doc.getElementsByTagName('binary')[0]!.textContent!;
    expect(base64Text).not.toContain('\r');
    const lines = base64Text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) expect(line.length).toBe(78);
  });

  it('cover — the reference and the binary carry one id, taken from the input (review M1)', () => {
    // A non-default id: a literal `#cover.png` in the coverpage would now name no target.
    const { head, tail } = renderFb2({ ...BASE, cover: { ...BASE.cover, id: 'plate.png' } });
    const doc = parseXml(`${head}\n   <date value="2026-10-27">2026-10-27T14:03:12+03:00</date>${tail}`);
    const image = doc.getElementsByTagName('coverpage')[0]!.getElementsByTagName('image')[0]!;
    const binary = doc.getElementsByTagName('binary')[0]!;
    const href = image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    expect(href).toBe('#plate.png');
    expect(binary.getAttribute('id')).toBe('plate.png');
    // The agreement itself: the reference is the binary's id, not a second literal.
    expect(href).toBe(`#${binary.getAttribute('id')}`);
  });

  it('the produced file is the book plus the cover — its size is ≥ 1.4 MB', async () => {
    await boot({ 'ch01.md': FRAME_FIRST_SENTENCE });
    const response = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(response.statusCode).toBe(200);
    const size = Buffer.byteLength(response.body);
    expect(size).toBeGreaterThanOrEqual(1.4 * 1024 * 1024);
  });

  it('two exports of one edition build identical bytes', async () => {
    const clock = new Date('2026-10-27T11:03:12Z');
    await boot({ '00-front.md': FRONT, 'ch07.md': CHAPTER_SEVEN }, () => clock);
    const first = await app!.inject({ method: 'GET', url: '/book.fb2' });
    const second = await app!.inject({ method: 'GET', url: '/book.fb2' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(Buffer.compare(Buffer.from(first.body), Buffer.from(second.body))).toBe(0);
    expect(first.headers.etag).toBe(second.headers.etag);
  });
});

describe('the escaper (BOOK-DOC-41 §4)', () => {
  it('is total: control characters and lone surrogates are dropped, markup is escaped, quotes stay', () => {
    expect(esc('a\u0000b\u0001c\u0008d\u000Be\u000Cf\u000Eg\u001Fh\uFFFEi\uFFFFj')).toBe('abcdefghij');
    // A valid pair is one code point and survives; an unpaired half is not a character.
    expect(esc('𝄞')).toBe('𝄞');
    expect(esc('a\uD800b')).toBe('ab');
    expect(esc('a\uDC00b')).toBe('ab');
    expect(esc('&<>')).toBe('&amp;&lt;&gt;');
    expect(esc('&amp;')).toBe('&amp;amp;');
    expect(esc('"quoted"')).toBe('"quoted"');
  });
});

describe('the export moment (BOOK-DOC-41 §2)', () => {
  it('renders an instant in the configured zone with its offset and the local date value', () => {
    expect(exportMoment(new Date('2026-10-27T11:03:12Z'), 'Europe/Moscow')).toEqual({
      text: '2026-10-27T14:03:12+03:00',
      value: '2026-10-27',
    });
  });

  it('follows the configured zone, never the host clock', () => {
    expect(exportMoment(new Date('2026-10-27T11:03:12Z'), 'Asia/Tokyo')).toEqual({
      text: '2026-10-27T20:03:12+09:00',
      value: '2026-10-27',
    });
    expect(exportMoment(new Date('2026-10-27T11:03:12Z'), 'America/New_York')).toEqual({
      text: '2026-10-27T07:03:12-04:00',
      value: '2026-10-27',
    });
  });

  it('takes the offset of the instant across a DST change', () => {
    // Europe/Berlin switches CEST at 01:00 UTC on 2026-03-29.
    expect(exportMoment(new Date('2026-03-29T00:30:00Z'), 'Europe/Berlin').text).toBe(
      '2026-03-29T01:30:00+01:00',
    );
    expect(exportMoment(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin').text).toBe(
      '2026-03-29T03:30:00+02:00',
    );
  });
});
