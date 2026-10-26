import type { FrontDto } from '@book/shared';

/**
 * Page 2 (BOOK-DOC-5 §3, ARCHITECTURE §6C.2, §11.8): the live annotation, set as the
 * opening of the prose. It is the book's first text, not a blurb about the book — no
 * visible label, no box, no animation; the accessible name lives in the `aria-label`.
 * A malformed first sheet renders nothing here — the site never fabricates a blurb.
 */
export function Annotation({ front }: { front: FrontDto }) {
  if (front.about === null) return null;
  const paragraphs = front.about
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return (
    <section className="page annotation" id="about" aria-label="о чём эта книга">
      {paragraphs.map((paragraph, index) => (
        <p className="p" key={index}>
          {paragraph}
        </p>
      ))}
    </section>
  );
}
