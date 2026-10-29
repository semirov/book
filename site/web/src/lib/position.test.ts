// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import {
  chapterOfPlace,
  parseSentenceId,
  placeAtLine,
  resolvePlace,
  sentenceElement,
  sentenceIdOf,
  SENTENCE_ID_PATTERN,
  type Place,
} from './position.ts';

/**
 * BOOK-209 — the pure half of the position layer: the anchor keys, the level a line names and
 * the chain a restore falls back through. jsdom has no layout, so every box here is a stub in
 * viewport coordinates; what is proved is the arithmetic and the order, not a browser's render.
 */

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** One box in viewport coordinates — the page's scroll is zero in this file. */
function boxOf(element: Element, top: number, height: number): void {
  element.getBoundingClientRect = () => rect(top, height);
}

/**
 * A page with two chapters: ch12 holds two paragraphs and three sentences, ch13 holds no prose
 * at all, and the cover above ch12 and the gap between the chapters belong to no chapter.
 */
function page(): void {
  document.body.innerHTML = `
    <header class="top"></header>
    <article data-n="12" id="ch-12">
      <header class="ch-h"></header>
      <p id="ch-12-b3" data-block-id="ch12#aabbccdd">
        <span data-s="0" data-quote="Первое предложение."></span>
        <span data-s="40" data-quote="Второе предложение."></span>
      </p>
      <p id="ch-12-b4" data-block-id="ch12#9955aa77">
        <span data-s="0" data-quote="Третий абзац."></span>
      </p>
    </article>
    <article data-n="13" id="ch-13"></article>
  `;
  boxOf(document.querySelector('.top') as Element, 0, 56);
  boxOf(document.getElementById('ch-12') as Element, 1_000, 800);
  boxOf(document.getElementById('ch-12-b3') as Element, 1_100, 200);
  boxOf(document.querySelectorAll('[data-s]')[0] as Element, 1_100, 20);
  boxOf(document.querySelectorAll('[data-s]')[1] as Element, 1_160, 20);
  boxOf(document.getElementById('ch-12-b4') as Element, 1_320, 100);
  boxOf(document.querySelectorAll('[data-s]')[2] as Element, 1_320, 20);
  boxOf(document.getElementById('ch-13') as Element, 1_900, 300);
}

const at = (line: number): Place | null => placeAtLine(document, line);

describe('the anchor keys (BOOK-209)', () => {
  it('names a sentence, a paragraph and a chapter, all inside the server’s one pattern', () => {
    expect(sentenceIdOf(12, 'ch12#aabbccdd', 140)).toBe('ch12#aabbccdd/s140');
    expect(sentenceIdOf(12, 'ch12#aabbccdd')).toBe('ch12#aabbccdd/p');
    expect(sentenceIdOf(12)).toBe('ch12');
    for (const key of [sentenceIdOf(12, 'ch12#aabbccdd', 140), sentenceIdOf(12, 'ch12#aabbccdd'), sentenceIdOf(12)]) {
      expect(SENTENCE_ID_PATTERN.test(key), key).toBe(true);
    }
  });

  it('round-trips every level, and refuses a key that is not one', () => {
    expect(parseSentenceId('ch12#aabbccdd/s140')).toEqual({ level: 'sentence', blockId: 'ch12#aabbccdd', start: 140 });
    expect(parseSentenceId('ch12#aabbccdd/p')).toEqual({ level: 'paragraph', blockId: 'ch12#aabbccdd' });
    expect(parseSentenceId('ch42')).toEqual({ level: 'chapter', chapter: 42 });
    for (const key of ['', 'ch0', 'ch43', 'ch12#aabbccdd', 'ch12#aabbccdd/s', 'ch12#aabbccdd/x1', '#']) {
      expect(parseSentenceId(key), key).toBeNull();
    }
  });

  it('reads the chapter off a chapter key and off the place’s own field otherwise', () => {
    expect(chapterOfPlace({ chapter: 4, sentenceId: 'ch12', deltaPx: 0, at: '2026-10-29T08:00:00Z' })).toBe(12);
    expect(chapterOfPlace({ chapter: 4, sentenceId: 'ch12#aabbccdd/s4', deltaPx: 0, at: '2026-10-29T08:00:00Z' })).toBe(4);
  });
});

describe('the place at the reading line', () => {
  it('names the sentence the line stands in, with the signed delta it stands from the line by', () => {
    page();
    // The line (1 105) is inside the first sentence, whose top is 5 px above it: the delta is
    // negative, so the next landing puts the sentence back above the line instead of pulling it
    // down to it (a whole line, or a whole paragraph in the fallback).
    const place = at(1_105);
    expect(place).toMatchObject({ chapter: 12, sentenceId: 'ch12#aabbccdd/s0', deltaPx: -5 });
    // `at` is a full ISO instant: the wire's own rule, never a local date string.
    expect(place?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it('takes the first sentence below a line that fell between two of them', () => {
    page();
    // 1 130 is inside the paragraph but above the second sentence (1 160): the reader is reading
    // towards it, and the delta says how far below the line it sat.
    expect(at(1_130)).toMatchObject({ sentenceId: 'ch12#aabbccdd/s40', deltaPx: 30 });
  });

  it('falls to the paragraph when no sentence holds the line or stands below it', () => {
    page();
    // The paragraph's own top (1 320) is above the line (1 350), and the delta says so.
    expect(at(1_350)).toMatchObject({ chapter: 12, sentenceId: 'ch12#9955aa77/p', deltaPx: -30 });
  });

  it('falls to the chapter when its prose has not arrived', () => {
    page();
    expect(at(1_950)).toMatchObject({ chapter: 13, sentenceId: 'ch13', deltaPx: -50 });
  });

  it('names nothing where no chapter owns the line: the cover, a gap, the end matter', () => {
    page();
    expect(at(900)).toBeNull();
    expect(at(1_850)).toBeNull();
    expect(at(2_400)).toBeNull();
  });
});

describe('resolving a place', () => {
  const place = (chapter: number, sentenceId: string): Place => ({
    chapter,
    sentenceId,
    deltaPx: 12,
    at: '2026-10-29T08:00:00.000Z',
  });

  it('finds the sentence first, by its paragraph’s block id and its own start', () => {
    page();
    const resolved = resolvePlace(document, place(12, 'ch12#aabbccdd/s40'));
    expect(resolved?.level).toBe('sentence');
    expect(resolved?.element.getAttribute('data-s')).toBe('40');
  });

  it('a start that is no longer a sentence is a miss: the paragraph is the next honest place', () => {
    page();
    const shifted = resolvePlace(document, place(12, 'ch12#aabbccdd/s41'));
    expect(shifted?.level).toBe('paragraph');
    expect(shifted?.element.id).toBe('ch-12-b3');

    // A start whose span carries no prose is the same miss: a stale anchor is never a guess.
    const span = document.querySelectorAll<HTMLElement>('[data-s]')[1] as HTMLElement;
    span.dataset.quote = '';
    span.textContent = '';
    expect(resolvePlace(document, place(12, 'ch12#aabbccdd/s40'))?.level).toBe('paragraph');
  });

  it('resolves a paragraph place by the block id, never by an index the page may reorder', () => {
    page();
    const resolved = resolvePlace(document, place(12, 'ch12#9955aa77/p'));
    expect(resolved?.level).toBe('paragraph');
    expect(resolved?.element.id).toBe('ch-12-b4');
  });

  it('falls to the chapter’s mouth, and null for a chapter this page does not hold', () => {
    page();
    expect(resolvePlace(document, place(12, 'ch12#nothash/p'))).toMatchObject({ level: 'chapter' });
    expect(resolvePlace(document, place(5, 'ch05#nothash/s1'))).toBeNull();
  });

  it('scopes the block to its own chapter: the same block id in another chapter is a miss', () => {
    page();
    // ch13 is on the page but holds no prose: the block of ch12 is not its block.
    expect(resolvePlace(document, place(13, 'ch12#aabbccdd/s0'))).toMatchObject({ level: 'chapter' });
  });

  it('finds a block whose id needs escaping in an environment without CSS.escape', () => {
    page();
    const block = document.createElement('p');
    block.dataset.blockId = 'ch12#odd"id';
    document.getElementById('ch-12')?.append(block);
    vi.stubGlobal('CSS', undefined);
    try {
      expect(resolvePlace(document, place(12, 'ch12#odd"id/p'))?.element).toBe(block);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('answers null for a sentence element queried through a block that holds none', () => {
    page();
    const block = document.getElementById('ch-12-b4') as HTMLElement;
    expect(sentenceElement(block, 0)?.getAttribute('data-s')).toBe('0');
    expect(sentenceElement(block, 40)).toBeNull();
  });
});
