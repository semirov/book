import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FRAME_MODE,
  FRAME_MARKS,
  FRAME_WARNING,
  classifyFrame,
  framePaperworkReason,
  normalizeFrameMark,
} from '../src/frame.ts';
import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, frameSentenceOf } from '../src/book.ts';
import { RETRO_MODES } from '../src/change.ts';

/**
 * BOOK-137 — one classifier for "how does this filing sit against the book's frame".
 *
 * The sentences are the canon ones (`book.ts`), never a copy: ch01 opens with the first, ch67
 * closes with the last. `touched` is about the sentence, `adjacent` about its paragraph,
 * `untouched` about everything else — and a chapter with no frame is never touched.
 */

const FRAME = FRAME_FIRST_SENTENCE;
/** The frame's own second sentence: quoting it is still quoting the sentence. */
const SECOND = 'Её освещал яркий свет.';
/** Prose that follows the frame in the same paragraph, after BOOK-32 allows it on one line. */
const AFTER = 'Я постоял и вышел.';

function mark(input: Partial<Parameters<typeof classifyFrame>[0]> & { chapter: number }): string {
  return classifyFrame({ quote: null, blockIndex: null, blockText: null, blockCount: 1, ...input });
}

describe('classifyFrame — the mark a filing carries (BOOK-137)', () => {
  it('is `touched` when the quote is the sentence or a part of it', () => {
    // The canon sentence, its own second sentence, and a fragment of it: all intersect.
    expect(mark({ chapter: 1, quote: FRAME, blockIndex: 0, blockText: FRAME })).toBe('touched');
    expect(mark({ chapter: 1, quote: SECOND })).toBe('touched');
    expect(mark({ chapter: 1, quote: 'пустую комнату' })).toBe('touched');
    // The other direction: the reader quoted more than the sentence — it still contains it.
    expect(mark({ chapter: 1, quote: `${FRAME} ${AFTER}` })).toBe('touched');
    // ch67's closer is a sentence of its own, and the rule is the same at the other end.
    expect(mark({ chapter: 67, quote: FRAME_LAST_SENTENCE, blockIndex: 2, blockText: FRAME_LAST_SENTENCE })).toBe(
      'touched',
    );
    expect(mark({ chapter: 67, quote: 'не осталось глаз' })).toBe('touched');
  });

  it('is `adjacent` for prose in the frame’s own paragraph, and for an empty quote on it', () => {
    expect(mark({ chapter: 1, quote: AFTER, blockIndex: 0, blockText: `${FRAME} ${AFTER}` })).toBe('adjacent');
    // The frame's block is index 0 on ch01 and the last one on ch67.
    expect(mark({ chapter: 1, blockIndex: 0, blockText: `${FRAME} ${AFTER}` })).toBe('adjacent');
    expect(mark({ chapter: 67, blockIndex: 2, blockText: `Он сел у окна. ${FRAME_LAST_SENTENCE}`, blockCount: 3 })).toBe(
      'adjacent',
    );
    // A rewrapped paragraph still holds the sentence: whitespace is not text.
    expect(mark({ chapter: 1, blockIndex: 0, blockText: FRAME.replace('Её', 'Её\n') })).toBe('adjacent');
  });

  it('is `adjacent` for the paragraph beside the frame — the one inside the chapter', () => {
    // ch01 opens on the frame, so the paragraph after it is the neighbour; ch67 closes on it,
    // so the paragraph before it is. The tap there is an ordinary edit, and the record says it
    // sat beside the sentence rather than 50 paragraphs away.
    expect(mark({ chapter: 1, blockIndex: 1, blockText: 'Свет был включён до меня.', blockCount: 3 })).toBe(
      'adjacent',
    );
    expect(mark({ chapter: 1, blockIndex: 1, blockText: 'Свет был включён до меня.', blockCount: 4 })).toBe(
      'adjacent',
    );
    expect(mark({ chapter: 67, blockIndex: 1, blockText: 'Часы на стене шли.', blockCount: 3 })).toBe('adjacent');
    expect(mark({ chapter: 67, blockIndex: 2, blockText: 'Часы на стене шли.', blockCount: 4 })).toBe('adjacent');
  });

  it('is `untouched` from the third block on, and for every chapter without a frame', () => {
    // One block further is an ordinary paragraph: the mark tells the neighbour from the far
    // filing, not every filing in a chapter that carries a frame.
    expect(mark({ chapter: 1, blockIndex: 2, blockText: 'Часы на стене шли.', blockCount: 4 })).toBe('untouched');
    expect(
      mark({ chapter: 1, quote: 'Свет был включён до меня.', blockIndex: 3, blockText: 'Свет был включён до меня.', blockCount: 4 }),
    ).toBe('untouched');
    expect(mark({ chapter: 67, blockIndex: 0, blockText: 'Первый абзац финала.', blockCount: 3 })).toBe('untouched');
    // A chapter with no frame sentence is never touched, even by prose that looks like it.
    expect(mark({ chapter: 2, quote: FRAME, blockIndex: 0, blockText: FRAME })).toBe('untouched');
    expect(mark({ chapter: 2, blockIndex: 0, blockCount: 1 })).toBe('untouched');
  });

  it('reads a chapter-level filing as untouched, and a chapter with no paragraphs safely', () => {
    expect(mark({ chapter: 1, blockCount: 1 })).toBe('untouched');
    expect(mark({ chapter: 67, blockCount: 0 })).toBe('untouched');
  });

  it('keeps one mark vocabulary and one default paperwork mode', () => {
    expect(FRAME_MARKS).toEqual(['touched', 'adjacent', 'untouched']);
    expect(RETRO_MODES).toContain(DEFAULT_FRAME_MODE);
    expect(DEFAULT_FRAME_MODE).toBe('оформление');
    expect(normalizeFrameMark('touched')).toBe('touched');
    expect(normalizeFrameMark('changed')).toBeNull();
    expect(normalizeFrameMark(null)).toBeNull();
  });

  it('states the warning and the paperwork reason in the book’s voice', () => {
    expect(FRAME_WARNING).toBe('это рамка книги: правка будет рассмотрена, фраза не изменится');
    for (const mode of RETRO_MODES) {
      const reason = framePaperworkReason(mode);
      expect(reason).toBe(`принято как ${mode}: рамка книги — фраза не меняется`);
      expect(reason.length).toBeLessThanOrEqual(200);
      // Never an exclamation, never a role, never a claim that the sentence changed.
      expect(reason).not.toContain('!');
      expect(reason).not.toContain('изменена');
    }
  });

  it('names the canon sentences it classifies against, and no others', () => {
    expect(frameSentenceOf(1)).toBe(FRAME);
    expect(frameSentenceOf(67)).toBe(FRAME_LAST_SENTENCE);
    expect(frameSentenceOf(2)).toBeNull();
  });
});
