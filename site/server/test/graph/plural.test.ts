/**
 * The counted nouns (BOOK-174). Two rules, one per language, and the exception that a naive
 * implementation always gets wrong: 11–14 are «many» in Russian although they end in 1–4.
 */

import { describe, expect, it } from 'vitest';

import { plural, pluralAcc, pluralEn } from '../../src/graph/plural.ts';

describe('plural (Russian)', () => {
  it('declines узел at every count the book meets', () => {
    const nodes = (n: number): string => plural(n, 'узел', 'узла', 'узлов');
    expect(nodes(1)).toBe('узел');
    expect(nodes(2)).toBe('узла');
    expect(nodes(4)).toBe('узла');
    expect(nodes(5)).toBe('узлов');
    // 11–14 take the many form although they end in 1–4.
    expect(nodes(11)).toBe('узлов');
    expect(nodes(12)).toBe('узлов');
    expect(nodes(13)).toBe('узлов');
    expect(nodes(14)).toBe('узлов');
    expect(nodes(21)).toBe('узел');
    expect(nodes(22)).toBe('узла');
    expect(nodes(25)).toBe('узлов');
    expect(nodes(101)).toBe('узел');
    expect(nodes(111)).toBe('узлов');
    expect(nodes(0)).toBe('узлов');
  });

  it('declines the other three vocabularies the same way', () => {
    expect(plural(1, 'глава', 'главы', 'глав')).toBe('глава');
    expect(plural(4, 'глава', 'главы', 'глав')).toBe('главы');
    expect(plural(12, 'глава', 'главы', 'глав')).toBe('глав');
    expect(plural(2, 'патч', 'патча', 'патчей')).toBe('патча');
    expect(plural(5, 'патч', 'патча', 'патчей')).toBe('патчей');
    expect(plural(1, 'знак', 'знака', 'знаков')).toBe('знак');
    expect(plural(22, 'знак', 'знака', 'знаков')).toBe('знака');
    expect(plural(25, 'знак', 'знака', 'знаков')).toBe('знаков');
  });
});

/**
 * The accusative of a counted noun (BOOK-174): the verb governs it, so «правка задевает 1 главу»
 * — the singular is its own form, 2–4 `главы` and 5+ `глав` are shared with the nominative.
 */
describe('pluralAcc (Russian accusative)', () => {
  it('changes the singular only, and keeps the 11–14 exception', () => {
    const chapters = (n: number): string => pluralAcc(n, 'главу', 'главы', 'глав');
    expect(chapters(1)).toBe('главу');
    expect(chapters(2)).toBe('главы');
    expect(chapters(4)).toBe('главы');
    expect(chapters(5)).toBe('глав');
    expect(chapters(11)).toBe('глав');
    expect(chapters(12)).toBe('глав');
    expect(chapters(21)).toBe('главу');
    expect(chapters(22)).toBe('главы');
    expect(chapters(0)).toBe('глав');
  });
});

describe('pluralEn', () => {
  it('singularises only one, so 21 runs is still plural', () => {
    expect(pluralEn(1, 'run', 'runs')).toBe('run');
    expect(pluralEn(2, 'run', 'runs')).toBe('runs');
    expect(pluralEn(21, 'run', 'runs')).toBe('runs');
    expect(pluralEn(101, 'run', 'runs')).toBe('runs');
    expect(pluralEn(0, 'chapter', 'chapters')).toBe('chapters');
    expect(pluralEn(1, 'seed', 'seeds')).toBe('seed');
  });
});
