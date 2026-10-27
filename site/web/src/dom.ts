/** Browser helpers kept out of `lib/` so the reducers and pacing logic stay testable. */

export function scrollToChapter(n: number): void {
  const target = document.getElementById(`ch-${n}`);
  if (target === null) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function nearViewport(element: Element, ahead = 1.5): boolean {
  const rect = element.getBoundingClientRect();
  const height = window.innerHeight || 800;
  return rect.bottom > -ahead * height && rect.top < height * (1 + ahead);
}

/** Is the element with this id on screen right now? (`toc` asks this before a notice.) */
export function elementInViewport(id: string): boolean {
  const element = document.getElementById(id);
  if (element === null) return false;
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < (window.innerHeight || 800);
}

export function chapterInViewport(n: number): boolean {
  const element = document.getElementById(`ch-${n}`);
  if (element === null) return false;
  const rect = element.getBoundingClientRect();
  const height = window.innerHeight || 800;
  return rect.bottom > 0 && rect.top < height;
}

/**
 * Make every top-level page sibling inert while the focus dialog is open (§11.9 rule 1):
 * the book stays legible behind the lamp, but it is not focusable and not clickable.
 */
export function inertBackground(dialog: HTMLElement | null): () => void {
  const inerted: HTMLElement[] = [];
  for (const child of [...(document.getElementById('root')?.children ?? [])]) {
    if (!(child instanceof HTMLElement)) continue;
    if (child === dialog || child.contains(dialog)) continue;
    child.inert = true;
    inerted.push(child);
  }
  return () => {
    for (const element of inerted) element.inert = false;
  };
}
