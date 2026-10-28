import { ABOUT_MAX_BLOCKS, ABOUT_MAX_CHARS, ABOUT_MIN_CHARS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { parseFront } from '../src/ingest/parseFront.ts';

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

/**
 * A synthetic sheet of the owner's shape: one title line, nine paragraphs, inside the annotation
 * band (300–4 000 chars, ≤12 blocks). Neutral on purpose — a fixture never carries book prose.
 */
const SHEET_TITLE = 'Бланк';
const SHEET_PARAGRAPHS = [
  'Служебный первый абзац первой страницы: он проверяет длину, разбиение на блоки и то, что заголовок не входит в текст книги.',
  'Служебный второй абзац. Здесь достаточно слов, чтобы аннотация перешла нижнюю границу полосы и разбор не спутал её с заглушкой.',
  'Служебный третий абзац. Каждый блок отделён пустой строкой, и разбор обязан вернуть их ровно столько, сколько их в листе.',
  'Служебный четвёртый абзац. Ни один блок не содержит разметки: список, курсив или заголовок сделали бы аннотацию негодной.',
  'Служебный пятый абзац. Абзацы не сливаются и не разрезаются: граница блока — пустая строка, и только она.',
  'Служебный шестой абзац. Тире, кавычки и точки стоят как в обычной прозе, чтобы разбор не зависел от пунктуации.',
  'Служебный седьмой абзац. Хвостовые пробелы и переводы строк нормализуются до того, как лист получит свой хэш.',
  'Служебный восьмой абзац. Девяти блоков достаточно: это форма листа владельца, а не бюджет страницы.',
  'Служебный девятый абзац, последний: после него ровно один перевод строки и больше ничего.',
];
const SHEET = `${SHEET_TITLE}\n\n${SHEET_PARAGRAPHS.join('\n\n')}\n`;

describe('parseFront', () => {
  it('reads the live title and page 2', () => {
    const parsed = parseFront(`Без названия\n\n${ABOUT}\n`);
    expect(parsed.title).toBe('Без названия');
    expect(parsed.about).toBe(ABOUT);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.chars).toBe(ABOUT.length);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('normalizes CRLF before hashing and keeps the snapshot text normalized', () => {
    const parsed = parseFront(`Название\r\n\r\n${ABOUT}\r\n`);
    expect(parsed.text).not.toContain('\r');
    expect(parsed.title).toBe('Название');
    expect(parsed.about).toBe(ABOUT);
  });

  it('keeps page 2 as blocks separated by a blank line', () => {
    const half = 'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
    const secondHalf = ABOUT.slice(half.length).trim();
    const parsed = parseFront(`Название\n\n${half}\n\n${secondHalf}`);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.about).toBe(`${half}\n\n${secondHalf}`);
  });

  it('nulls page 2 when the annotation is malformed, keeping the title', () => {
    const parsed = parseFront('Название\n\nСлишком коротко.');
    expect(parsed.title).toBe('Название');
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain(`expected ${ABOUT_MIN_CHARS}–${ABOUT_MAX_CHARS}`);
  });

  it('accepts a nine-paragraph sheet of the owner\'s shape with zero problems', () => {
    // A fixture, not the owner's file: since BOOK-187 the text is rows (`front_matter`), so the
    // real sheet is checked on deploy by `node bin/validate.mjs --from-db "$DATA_DIR"`, which
    // runs the same F021 rules (title line, 300–4 000 chars in ≤12 blocks) over the row.
    const parsed = parseFront(SHEET);
    expect(parsed.problems).toEqual([]);
    expect(parsed.title).toBe(SHEET_TITLE);
    expect(parsed.blocks).toHaveLength(9);
    expect(parsed.blocks.length).toBeLessThanOrEqual(ABOUT_MAX_BLOCKS);
    expect(parsed.chars).toBeGreaterThanOrEqual(ABOUT_MIN_CHARS);
    expect(parsed.chars).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
    // The count is the paragraphs' own characters, not the blank lines between them.
    expect(parsed.chars).toBe(SHEET_PARAGRAPHS.reduce((sum, paragraph) => sum + paragraph.length, 0));
  });

  it('is the nine paragraphs and nothing else, with no site copy inside (BOOK-39)', () => {
    // BOOK-39: page 2 is the book's own words, verbatim. The «как сделана книга» block is site
    // copy — it names the auditor, the writer and the wave — and must never be ingested as the
    // annotation. Its own half is pinned in `web/src/components/howTheBookIsMade.test.tsx`;
    // the book's half has no copy in this tree any more, so what holds here is that the parser
    // neither merges nor appends: the sheet parses back paragraph for paragraph.
    expect(SHEET).not.toContain('***');
    const parsed = parseFront(SHEET);
    expect(parsed.blocks).toEqual(SHEET_PARAGRAPHS);
    expect(parsed.about).toBe(SHEET_PARAGRAPHS.join('\n\n'));
    for (const explanation of [
      'Мы пишем книгу без готового плана. Есть начало, конец и шестьдесят семь пустых глав между ними.',
      'Прошлое при этом не маскируется, а оформляется: у всякой причины появляется бланк.',
      'Авторство здесь не измеряется числом написанных слов. Оно измеряется тем, что дожило.',
    ]) {
      expect(parsed.about, 'the site copy must stay out of the annotation').not.toContain(explanation);
    }
  });

  it('nulls the title when line 1 is malformed', () => {
    const parsed = parseFront(`${'я'.repeat(81)}\n\n${ABOUT}`);
    expect(parsed.title).toBeNull();
    expect(parsed.about).toBe(ABOUT);
  });

  it('hashes page 2 alone, so a new title cannot move the annotation hash (BOOK-DOC-6)', () => {
    const first = parseFront(`Без названия\n\n${ABOUT}\n`);
    const retitled = parseFront(`Другое название\n\n${ABOUT}\n`);
    expect(retitled.sha256).not.toBe(first.sha256);
    expect(retitled.aboutSha256).toBe(first.aboutSha256);
    expect(retitled.aboutSha256).toMatch(/^[0-9a-f]{64}$/u);

    const rewritten = parseFront(`Другое название\n\n${ABOUT.replace('Тестовая', 'Чужая')}\n`);
    expect(rewritten.aboutSha256).not.toBe(first.aboutSha256);
    // A malformed rewrite still has a hash: the gate must see the attempt, not a null.
    const broken = parseFront('Другое название\n\nСлишком коротко.');
    expect(broken.aboutSha256).not.toBe(first.aboutSha256);
  });
});
