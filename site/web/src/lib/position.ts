/**
 * BOOK-209 — **a place is an anchor in the text, never a pixel of scroll.**
 *
 * The reader's place is stored, sent to the server and restored from it, so it must survive a
 * reflow: another screen, another font size, a chapter whose prose had not been read when the
 * reader left. A `scrollTop` survives none of them. So a place names three things and they are
 * the same arithmetic the page already renders:
 *
 *   - a **sentence**: `"<blockId>/s<startChar>"` — the paragraph's own `data-block-id`
 *     (`ch12#aabbccdd`) and the sentence span's `data-s` (the character the sentence starts on);
 *   - a **paragraph**: `"<blockId>/p"` — for a line that stands between sentences;
 *   - a **chapter**: `"ch<N>"` — for a line that no sentence and no paragraph owns.
 *
 * All three fit the server's one key pattern (`/^[A-Za-z0-9#._:/-]{1,200}$/`), so the client
 * needs no escape rule of its own, and every level is resolved in the same order the reader
 * would fall back in: sentence → paragraph → chapter. `deltaPx` is the only pixel anywhere, and
 * it says how far below the reading line the anchor stood — **signed**: a sentence whose top is
 * already above the line stands at a negative distance, and the next landing puts it back above
 * the line rather than pulling it down to the line.
 *
 * Nothing here reads `scrollTop` and nothing here stores a height: the capture measures rects at
 * the reading line, and the restore finds the element first and lands it second
 * (`lib/landing.ts`).
 */

import { TOTAL_CHAPTERS, type ReaderPlaceDto } from '@book/shared';

/** The reader's place, as the store, the wire and this file's arithmetic carry it. */
export type Place = ReaderPlaceDto;

/** An anchor's three levels, coarsest last — the order a miss falls back through. */
export type AnchorLevel = 'sentence' | 'paragraph' | 'chapter';

/**
 * The one key pattern — the server's own (`server/src/http/routes/place.ts`). A key that does
 * not fit it is not a key this page may store or send, so every builder below is checked
 * against it and a paragraph whose id fails falls back to its chapter.
 */
export const SENTENCE_ID_PATTERN = /^[A-Za-z0-9#._:/-]{1,200}$/u;

/** A parsed anchor key. */
export type ParsedAnchor =
  | { level: 'chapter'; chapter: number }
  | { level: 'paragraph'; blockId: string }
  | { level: 'sentence'; blockId: string; start: number };

const CHAPTER_KEY = /^ch(\d{1,3})$/u;
const PARAGRAPH_KEY = /^(.+)\/p$/u;
const SENTENCE_KEY = /^(.+)\/s(\d{1,7})$/u;

/**
 * The anchor key of one place: the chapter's own key (`ch12`) when no block is named, the
 * paragraph's (`ch12#aabbccdd/p`) when no sentence is, and the sentence's
 * (`ch12#aabbccdd/s140`) otherwise.
 */
export function sentenceIdOf(chapter: number, blockId: string | null = null, start: number | null = null): string {
  if (blockId === null) return `ch${String(chapter)}`;
  if (start === null) return `${blockId}/p`;
  return `${blockId}/s${String(Math.max(0, Math.round(start)))}`;
}

/** The level a key names, and the parts it names them with; `null` for a key that is not one. */
export function parseSentenceId(sentenceId: string): ParsedAnchor | null {
  const chapter = CHAPTER_KEY.exec(sentenceId);
  if (chapter !== null) {
    const n = Number(chapter[1]);
    if (!Number.isInteger(n) || n < 1 || n > TOTAL_CHAPTERS) return null;
    return { level: 'chapter', chapter: n };
  }
  const sentence = SENTENCE_KEY.exec(sentenceId);
  if (sentence !== null) {
    const start = Number(sentence[2]);
    if (!Number.isSafeInteger(start) || start < 0) return null;
    return { level: 'sentence', blockId: sentence[1] as string, start };
  }
  const paragraph = PARAGRAPH_KEY.exec(sentenceId);
  if (paragraph !== null) return { level: 'paragraph', blockId: paragraph[1] as string };
  return null;
}

/**
 * The chapter a place is in. The key carries it for a chapter-level place (`ch12`); every other
 * key names a block of a chapter and the place's own `chapter` field is the chapter.
 */
export function chapterOfPlace(place: Place): number {
  const parsed = parseSentenceId(place.sentenceId);
  return parsed !== null && parsed.level === 'chapter' ? parsed.chapter : place.chapter;
}

/** A box in viewport coordinates, as a browser reports it at the current scroll. */
type Box = { top: number; bottom: number; height: number };

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
}

/** Is the line inside this box? Half-open `[top, bottom)`, so a boundary belongs to what starts there. */
function holds(box: Box, line: number): boolean {
  return box.height > 0 && Number.isFinite(box.top) && line >= box.top && line < box.bottom;
}

/** `CSS.escape`, with an attribute-safe fallback for an environment that has none. */
function escapeAttribute(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/gu, '\\$&');
}

/** One sentence at (or just below) the line, inside one chapter. */
type SentenceHit = { blockId: string; start: number; top: number };

/**
 * The sentence at the line: the span whose box holds it, else the first one below it (a line
 * that fell in the air between two sentences still names the sentence it is reading towards).
 */
function sentenceAtLine(article: Element, line: number): SentenceHit | null {
  let below: SentenceHit | null = null;
  for (const span of article.querySelectorAll<HTMLElement>('[data-s]')) {
    const box = boxOf(span);
    if (!(box.height > 0) || !Number.isFinite(box.top)) continue;
    const block = span.closest<HTMLElement>('[data-block-id]');
    const blockId = block?.dataset.blockId ?? null;
    const start = Number.parseInt(span.dataset.s ?? '', 10);
    if (blockId === null || blockId === '' || !Number.isSafeInteger(start) || start < 0) continue;
    if (holds(box, line)) return { blockId, start, top: box.top };
    if (box.top > line && (below === null || box.top < below.top)) below = { blockId, start, top: box.top };
  }
  return below;
}

/** The paragraph at the line: the block whose own box holds it. */
function paragraphAtLine(article: Element, line: number): { blockId: string; top: number } | null {
  for (const block of article.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const blockId = block.dataset.blockId ?? '';
    if (blockId === '') continue;
    const box = boxOf(block);
    if (holds(box, line)) return { blockId, top: box.top };
  }
  return null;
}

/**
 * The place at the reading line, in the viewport's own coordinates.
 *
 * The chapter is the `article[data-n]` whose box holds the line — the cover, page 2, the
 * contents and the end matter hold none, and the answer there is `null` (`pageTrack.ts` says the
 * same about the folio). Inside the chapter the finest anchor the line touches wins: a sentence,
 * then a paragraph, then the chapter's own mouth. `deltaPx` is measured against the line itself,
 * never against the viewport's top, so the next landing can add it back.
 */
export function placeAtLine(doc: Document, line: number): Place | null {
  const at = new Date().toISOString();
  for (const article of doc.querySelectorAll<HTMLElement>('article[data-n]')) {
    const chapter = Number(article.dataset.n);
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) continue;
    const box = boxOf(article);
    if (!holds(box, line)) continue;

    const sentence = sentenceAtLine(article, line);
    if (sentence !== null) {
      const key = sentenceIdOf(chapter, sentence.blockId, sentence.start);
      if (SENTENCE_ID_PATTERN.test(key)) {
        return { chapter, sentenceId: key, deltaPx: sentence.top - line, at };
      }
    }
    const paragraph = paragraphAtLine(article, line);
    if (paragraph !== null) {
      const key = sentenceIdOf(chapter, paragraph.blockId);
      if (SENTENCE_ID_PATTERN.test(key)) {
        return { chapter, sentenceId: key, deltaPx: paragraph.top - line, at };
      }
    }
    return { chapter, sentenceId: sentenceIdOf(chapter), deltaPx: box.top - line, at };
  }
  return null;
}

/** The paragraph a block id names, inside its own chapter; `null` when the chapter is not on the page. */
export function paragraphElement(doc: Document, chapter: number, blockId: string): HTMLElement | null {
  // BOOK-209 — a place names the paragraph by its `data-block-id` (`ch12#aabbccdd`), not by the
  // index the page gives it (`#ch-12-bI`): the index is the page's ordering and the id is the
  // text's identity, so a re-ordered or re-read chapter still finds the paragraph it means.
  const scope = doc.getElementById(`ch-${String(chapter)}`);
  if (scope === null) return null;
  return scope.querySelector<HTMLElement>(`[data-block-id="${escapeAttribute(blockId)}"]`);
}

/**
 * The sentence a start names inside one paragraph, or `null` when that start is no longer a
 * sentence: a span that holds no prose (an empty quote, a stale start after a rewrite) is a
 * miss, and the caller falls back to the paragraph — never to a neighbouring sentence.
 */
export function sentenceElement(block: Element, start: number): HTMLElement | null {
  const span = block.querySelector<HTMLElement>(`[data-s="${String(start)}"]`);
  if (span === null) return null;
  const quote = span.dataset.quote ?? span.textContent ?? '';
  return quote.trim() === '' ? null : span;
}

/** What a place resolves to on this page, and at which level it stood. */
export type ResolvedPlace = { element: HTMLElement; level: AnchorLevel };

/**
 * Resolve a place on the page as it stands — sentence → paragraph → chapter, exactly that
 * order and nothing else. A sentence whose start no longer names prose is a miss that falls to
 * the paragraph; a paragraph the page does not hold falls to the chapter's mouth; a chapter the
 * page does not hold is `null` (that place is not on this page).
 */
export function resolvePlace(doc: Document, place: Place): ResolvedPlace | null {
  const parsed = parseSentenceId(place.sentenceId);
  if (parsed !== null && parsed.level !== 'chapter') {
    const block = paragraphElement(doc, place.chapter, parsed.blockId);
    if (block !== null) {
      if (parsed.level === 'paragraph') return { element: block, level: 'paragraph' };
      const sentence = sentenceElement(block, parsed.start);
      if (sentence !== null) return { element: sentence, level: 'sentence' };
      return { element: block, level: 'paragraph' };
    }
  }
  const chapter = doc.getElementById(`ch-${String(place.chapter)}`);
  if (chapter === null) return null;
  return { element: chapter, level: 'chapter' };
}
