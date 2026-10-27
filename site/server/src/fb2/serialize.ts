/**
 * BOOK-60 — the FB2 (FictionBook 2.0) mapping, hand-written (BOOK-DOC-41 §3, §4).
 *
 * No dependency, no XHTML, no inline styles: the element order is the schema's, the escaping
 * is total, and the serializer's only inputs are the field list below — the site's web copy,
 * the seam's numerals and the history annotations have no path into the file.
 *
 * The body is all 67 slots, in numeric order, `id="chNN"`. An empty slot is a titled section
 * with `<empty-line/>`; a basis-only slot (ch01/ch67) carries its one paragraph because the
 * site shows it. The front matter does not repeat in the body: page 2 is `title-info`.
 *
 * BOOK-133: `title-info/coverpage` names the one `binary` that closes the document. Both are
 * built from the caller's data, so the renderer stays pure — no fs, no clock, no encoding.
 */

import { allChapterNumbers, chapterLabel, splitParagraphs } from '@book/shared';

import { binaryElement, coverPageElement, type CoverBinary } from './cover.ts';

export type Fb2ChapterInput = {
  n: number;
  /** Line 1 of the chapter file; null when the chapter is untitled or a basis-only slot. */
  title: string | null;
  /** The chapter's paragraphs in `idx` order, hard wraps already collapsed. */
  paragraphs: readonly string[];
};

export type Fb2Input = {
  /** `front_matter.title`; a null or empty title falls back to «Книга» (the site's fallback). */
  title: string | null;
  /** `front_matter.about`; null or empty omits `title-info/annotation`. */
  about: string | null;
  /** `imprint.author`, verbatim: no invented first/last split. */
  author: string;
  /** `imprint.year`: rendered only when it is a four-digit year (`auto` is omitted). */
  year: string;
  /** The engine's version (`book-site <version>` in `program-used`). */
  version: string;
  /** `config.publicOrigin` + `/`. */
  srcUrl: string;
  revision: number;
  /**
   * BOOK-133: the image the file carries. Data, never a path — the renderer does no I/O, so a
   * caller (the route) owns reading, validating and memoising the cover.
   */
  cover: CoverBinary;
  chapters: readonly Fb2ChapterInput[];
};

/**
 * The file split around the export moment: `head` ends just before `document-info/date`, the
 * route inserts the date element of *this* response, `tail` starts at `src-url`.
 * `fb2/exportCache.ts` keeps a `head`/`tail` pair per edition *and cover*, so a repeated export
 * costs one concat.
 */
export type Fb2Parts = { head: string; tail: string };

export type Fb2Renderer = (input: Fb2Input) => Fb2Parts;

/**
 * XML 1.0 may not carry these characters, and a lone surrogate is not a character at all:
 * both are dropped rather than encoded, because there is no legal reference for them.
 * `for … of` walks code points, so a valid surrogate pair arrives as one character and only an
 * unpaired half is skipped.
 */
function withoutUnsafe(value: string): string {
  let kept = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (code <= 0x08 || code === 0x0b || code === 0x0c) continue;
    if (code >= 0x0e && code <= 0x1f) continue;
    if (code === 0xfffe || code === 0xffff) continue;
    kept += character;
  }
  return kept;
}

/**
 * The total escaper (§4): drop the characters XML cannot hold, then `&`, `<`, `>`. Quotes are
 * left alone — they are text in element content, and nothing here builds an attribute from
 * prose. Order matters: escaping `&` first is what keeps `&amp;` from becoming `&amp;amp;`.
 */
export function esc(value: string): string {
  return withoutUnsafe(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/**
 * The manuscript's hard wraps are line breaks of the source, not of the page (§3). Exported so
 * the route hands the serializer paragraphs that are already whole: a second caller cannot
 * reintroduce a newline inside a `p`, and `paragraphsOf` applies it again as a belt.
 */
export function paragraphText(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .join(' ');
}

export type ExportMoment = {
  /** `2026-10-27T14:03:12+03:00` — the instant with the offset of `config.tz`. */
  text: string;
  /** `2026-10-27` — the XSD's `dateType` value attribute. */
  value: string;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const held = formatters.get(timeZone);
  if (held !== undefined) return held;
  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timeZone, made);
  return made;
}

/**
 * The export moment (§2): the instant rendered in `config.tz`, never the host's clock zone.
 * `Intl` speaks the offset as `GMT+03:00`, and a bare `GMT` means `+00:00`.
 */
export function exportMoment(at: Date, timeZone: string): ExportMoment {
  const parts = formatterFor(timeZone).formatToParts(at);
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const offset = field('timeZoneName').replace(/^GMT/u, '') || '+00:00';
  const value = `${field('year')}-${field('month')}-${field('day')}`;
  return {
    value,
    text: `${value}T${field('hour')}:${field('minute')}:${field('second')}${offset}`,
  };
}

/** The one element the route injects between `head` and `tail`. */
export function dateElement(moment: ExportMoment): string {
  return `\n   <date value="${moment.value}">${moment.text}</date>`;
}

function paragraphsOf(values: readonly string[]): string {
  return values.map((value) => `<p>${esc(paragraphText(value))}</p>`).join('');
}

function annotationOf(about: string | null): string[] {
  if (about === null) return [];
  const blocks = splitParagraphs(about);
  if (blocks.length === 0) return [];
  return [
    '   <annotation>',
    ...blocks.map((block) => `    <p>${esc(paragraphText(block))}</p>`),
    '   </annotation>',
  ];
}

function sectionOf(n: number, chapter: Fb2ChapterInput | undefined): string {
  const titleLine =
    chapter !== undefined && chapter.title !== null && chapter.title.length > 0
      ? `<p>${esc(chapter.title)}</p>`
      : '';
  const prose =
    chapter === undefined || chapter.paragraphs.length === 0
      ? '<empty-line/>'
      : paragraphsOf(chapter.paragraphs);
  return `  <section id="ch${chapterLabel(n)}"><title><p>Глава ${n}</p>${titleLine}</title>${prose}</section>`;
}

export const renderFb2: Fb2Renderer = (input) => {
  const bookTitle = input.title !== null && input.title.length > 0 ? input.title : 'Книга';
  const yearLine = /^\d{4}$/u.test(input.year) ? [`   <date>${input.year}</date>`] : [];

  const head = [
    '<?xml version="1.0" encoding="utf-8"?>',
    // BOOK-133: `l:href` is the XLink namespace; a file that uses the prefix without
    // declaring it is not namespace-well-formed, and readers refuse it.
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">',
    ' <description>',
    '  <title-info>',
    '   <genre>sf</genre>',
    `   <author><nickname>${esc(input.author)}</nickname></author>`,
    `   <book-title>${esc(bookTitle)}</book-title>`,
    ...annotationOf(input.about),
    ...yearLine,
    coverPageElement(input.cover.id),
    '   <lang>ru</lang>',
    '  </title-info>',
    '  <document-info>',
    `   <author><nickname>${esc(input.author)}</nickname></author>`,
    `   <program-used>book-site ${esc(input.version)}</program-used>`,
  ].join('\n');

  const byNumber = new Map(input.chapters.map((chapter) => [chapter.n, chapter]));
  const sections = allChapterNumbers().map((n) => sectionOf(n, byNumber.get(n)));

  const tail = [
    `   <src-url>${esc(input.srcUrl)}</src-url>`,
    '   <id>urn:book:blank</id>',
    `   <version>${input.revision}</version>`,
    '  </document-info>',
    ' </description>',
    ' <body>',
    ...sections,
    ' </body>',
    binaryElement(input.cover),
    '</FictionBook>',
    '',
  ].join('\n');

  return { head, tail };
};
