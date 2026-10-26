import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ABOUT_MAX_CHARS, ABOUT_MIN_CHARS } from '@book/shared';
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

  it('accepts the owner\'s real first sheet as written: seven paragraphs, zero problems', () => {
    // The file itself, not a copy: the annotation is the owner's and it is longer and more
    // paragraphs than the old band allowed. Reading it keeps the test honest when it changes.
    const raw = readFileSync(join(import.meta.dirname, '..', '..', '..', 'manuscript', '00-front.md'), 'utf8');
    const parsed = parseFront(raw);
    expect(parsed.problems).toEqual([]);
    expect(parsed.title).toBe('Без названия');
    expect(parsed.blocks).toHaveLength(7);
    expect(parsed.chars).toBeGreaterThanOrEqual(ABOUT_MIN_CHARS);
    expect(parsed.chars).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
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
