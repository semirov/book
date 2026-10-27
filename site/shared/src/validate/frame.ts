/**
 * F029 — the frozen frame (BOOK-6, and the owner's canon page).
 *
 * The owner fixed the first sentence of chapter 1 and the last sentence of chapter 67, and
 * nobody edits them: not the writer, not a ripple, not a reader's change. The sentences live
 * once, in `../book.ts`, so the validator and the engine cannot disagree about what "the
 * frame" is.
 *
 * The frame is read from the **file**, not from the parsed blocks: in the owner's empty-book
 * state a chapter is one line with no title (a basis-only slot), and the same sentence must be
 * accepted as the whole file, as a title-less first line, and as the first/last prose sentence
 * after a title line. Whitespace is not text, so a rewrap passes and a changed word does not.
 */

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS, parseChapterTitle } from '../book.ts';
import { type ChapterFile, type Finding, lineAt } from './text.ts';

const FRAME_FIRST_CHAPTER = 1;
const FRAME_LAST_CHAPTER = TOTAL_CHAPTERS;
/** A reported sentence is an excerpt, never a paragraph. */
const SENTENCE_EXCERPT_MAX = 80;

/** Whitespace is not text: a rewrapped frame is the same frame. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function shorten(sentence: string): string {
  return sentence.length > SENTENCE_EXCERPT_MAX
    ? `${sentence.slice(0, SENTENCE_EXCERPT_MAX - 1)}…`
    : sentence;
}

/** The first sentence of the text, or the whole excerpt when it has no full stop yet. */
function firstSentence(value: string): string {
  const match = /^[^.!?…]*[.!?…]/u.exec(value);
  return shorten((match?.[0] ?? value).trim());
}

/** What the chapter ends with: the last sentence, or its tail when the text is longer. */
function lastSentence(value: string): string {
  const text = value.trim();
  if (text.length <= SENTENCE_EXCERPT_MAX) return text;
  return `…${text.slice(-(SENTENCE_EXCERPT_MAX - 1))}`;
}

/**
 * The chapter's text as prose: a title line is not text (§6C.3), and which line is a title is
 * the shared title decision — never "line 1 followed by a blank line", because a title-less
 * chapter that opens with the frozen sentence has exactly that shape, and dropping its first
 * line made F029 compare the second paragraph (BOOK-32).
 */
function proseText(chapter: ChapterFile): string {
  return collapseWhitespace(parseChapterTitle(chapter.n, chapter.text).body);
}

/** The line of a block, so a frame finding points at the sentence and not at the file. */
function blockLine(chapter: ChapterFile, index: number, fromEnd = false): number {
  const block = chapter.blocks[index];
  if (block === undefined) return 1;
  const at = fromEnd ? chapter.text.lastIndexOf(block) : chapter.text.indexOf(block);
  return lineAt(chapter.text, Math.max(0, at));
}

/** F029 findings: at most one per chapter, because a chapter has one frame sentence. */
export function checkFrame(chapter: ChapterFile): Finding[] {
  const body = proseText(chapter);
  // A slot with no text at all is an empty slot, not a broken frame (§BOOK-6).
  if (body.length === 0) return [];

  if (chapter.n === FRAME_FIRST_CHAPTER) {
    const expected = collapseWhitespace(FRAME_FIRST_SENTENCE);
    const rest = body.startsWith(expected) ? body.slice(expected.length) : null;
    if (rest !== null && (rest === '' || rest.startsWith(' '))) return [];
    const message = `the frame is fixed: chapter ${FRAME_FIRST_CHAPTER} must begin with «${expected}»`;
    return [
      {
        rule: 'F029',
        severity: 'error',
        file: chapter.file,
        line: blockLine(chapter, 0),
        message: `${message}; found «${firstSentence(body)}»`,
      },
    ];
  }

  if (chapter.n === FRAME_LAST_CHAPTER) {
    const expected = collapseWhitespace(FRAME_LAST_SENTENCE);
    const head = body.endsWith(expected) ? body.slice(0, body.length - expected.length) : null;
    if (head !== null && (head === '' || head.endsWith(' '))) return [];
    const message = `the frame is fixed: chapter ${FRAME_LAST_CHAPTER} must end with «${expected}»`;
    return [
      {
        rule: 'F029',
        severity: 'error',
        file: chapter.file,
        line: blockLine(chapter, chapter.blocks.length - 1, true),
        message: `${message}; found «${lastSentence(body)}»`,
      },
    ];
  }

  return [];
}
