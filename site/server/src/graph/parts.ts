/**
 * The book's parts (ADR-040 §7.2, BOOK-174): ch01 opens, ch42 closes, and the four bodies sit
 * between them. A part is not a chapter range a query may be narrowed to — the closure is
 * unbounded — it is the unit the expensive whole-book read is charged in: a closure that stays
 * inside one part needs no whole-book read, one that crosses a boundary gets +$0.09 (§4.6).
 *
 * Declared once because two modules price and report against it, and two lists of boundaries
 * would drift the day the book grows a part.
 */

export type Part = '1' | '2–11' | '12–21' | '22–31' | '32–41' | '42';

type Range = { part: Part; from: number; to: number };

/** In book order — the order parts are printed in. */
export const PARTS: readonly Range[] = [
  { part: '1', from: 1, to: 1 },
  { part: '2–11', from: 2, to: 11 },
  { part: '12–21', from: 12, to: 21 },
  { part: '22–31', from: 22, to: 31 },
  { part: '32–41', from: 32, to: 41 },
  // The finale. The ledger's CHECK allows chapters above 42 while the book opens 42; a chapter
  // past the finale is still outside the bodies, and pretending otherwise would invent a part.
  { part: '42', from: 42, to: 67 },
];

/** Which part a chapter belongs to. */
export function partOf(chapter: number): Part {
  for (const range of PARTS) if (chapter >= range.from && chapter <= range.to) return range.part;
  // Below chapter 1 the ledger's own CHECK refuses the row; a caller that got here is asking
  // about a chapter that cannot exist, and the opening part is the only honest answer.
  return '1';
}

/** The parts a set of chapters touches, in book order, each once. */
export function partsOf(chapters: readonly number[]): Part[] {
  const present = new Set(chapters.map(partOf));
  return PARTS.map((range) => range.part).filter((part) => present.has(part));
}
