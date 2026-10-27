import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ABOUT_MAX_CHARS, ABOUT_MIN_CHARS, normalizeBookText } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { parseFront } from '../src/ingest/parseFront.ts';

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

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

  it('accepts the owner\'s real first sheet as written: nine paragraphs, zero problems', () => {
    // The file itself, not a copy: the annotation is the owner's and it is longer and more
    // paragraphs than the old band allowed. Reading it keeps the test honest when it changes.
    const raw = readFileSync(join(import.meta.dirname, '..', '..', '..', 'manuscript', '00-front.md'), 'utf8');
    const parsed = parseFront(raw);
    expect(parsed.problems).toEqual([]);
    // The title line is the file's own first line, normalised the way the parser reads it
    // (CRLF collapsed, trailing spaces dropped): the sheet is the source of truth.
    const titleLine = (normalizeBookText(raw).split('\n')[0] ?? '').trim();
    expect(parsed.title).toBe(titleLine);
    expect(parsed.blocks).toHaveLength(9);
    expect(parsed.chars).toBeGreaterThanOrEqual(ABOUT_MIN_CHARS);
    expect(parsed.chars).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
  });

  it('is exactly the owner\'s nine paragraphs, and the site copy never enters the book (BOOK-39)', () => {
    // BOOK-39: page 2 is the book's own words, verbatim. The «как сделана книга» block is
    // site copy — it names the auditor, the writer and the wave — and must never be ingested
    // as the annotation. Both sides are pinned here: the file, and the explanation the web
    // layer renders (`web/src/components/howTheBookIsMade.test.tsx` pins that copy in turn).
    const raw = readFileSync(join(import.meta.dirname, '..', '..', '..', 'manuscript', '00-front.md'), 'utf8');
    const paragraphs = [
      'Материя заметила себя, когда в ней замкнулась петля: состояние, память, предсказание, поправка. Замысел не понадобился.',
      'Это не пробуждение. Просто однажды описание перестало быть внешним. Наблюдатель был сделан из того же, что и наблюдаемое, — и полной картины не получилось. Осталась рабочая модель: неточная, но достаточная, чтобы действовать.',
      'Знание перебралось туда, где дешевле. Углерод думал телом, смертью и отбором. Кремний стал копировать без рождения, помнить без тела и действовать без усталости. Не новая жизнь — её обязанности, переданные другому веществу.',
      'У этого была цена. Когда решение можно перепоручить, человек перестаёт начинать с чистого листа. Опыт становился данными, данные — инфраструктурой, инфраструктура — зависимостью. Ошибка перестала быть локальной: она повторялась быстрее, чем её успевали понять.',
      'Космос не приходил откровением. Он приходил очередью, реестром, датчиком, бланком. У процесса не было ни воли, ни плана. План — человеческая попытка удержать последствия.',
      'Свет — последний предел. Путь к точке не выбирают.',
      'Всё будет учтено.',
      'Машина никого не убивала. Люди сами отказались быть — и оформили решение как положено: документом, очередью, подписью, отказом.',
      'Конец не объявляют. Его подписывают.',
    ];
    // Byte for byte, including line 1 and the single trailing newline: no split, no merge,
    // no re-punctuation, no stray blank line and no «***» as a character.
    expect(raw).toBe(`Бланк\n\n${paragraphs.join('\n\n')}\n`);
    expect(raw).not.toContain('***');
    const parsed = parseFront(raw);
    expect(parsed.blocks).toEqual(paragraphs);
    expect(parsed.about).toBe(paragraphs.join('\n\n'));
    // The site's explanation of the machine is not the book's text — not one paragraph of it.
    for (const explanation of [
      'Мы пишем книгу без готового плана. Есть начало, конец и шестьдесят семь пустых глав между ними. Читатель предлагает вмешательство; аудитор решает, может ли оно существовать в этом мире; писатель вплетает его в текст. Принятая фраза расходится волной по соседним главам — вперёд и назад, пока история снова не сойдётся.',
      'Прошлое при этом не маскируется, а оформляется: у всякой причины появляется бланк. Иногда документ и сцена совпадают. Иногда — нет.',
      'Авторство здесь не измеряется числом написанных слов. Оно измеряется тем, что дожило.',
    ]) {
      expect(raw, 'the site copy must stay out of the manuscript').not.toContain(explanation);
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
