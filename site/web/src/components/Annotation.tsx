import type { FrontDto } from '@book/shared';

/**
 * Page 2 «о чём эта книга» (ARCHITECTURE §6C.2, §11.8): the live annotation, set as the
 * opening of the prose. It is the only place where the book describes itself. A malformed
 * first sheet renders nothing here — the site never fabricates a blurb.
 */
export function Annotation({ front }: { front: FrontDto }) {
  if (front.about === null) return null;
  const paragraphs = front.about
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return (
    <section className="page annotation" id="about" aria-label="о чём эта книга">
      <header className="sec-h">
        <span className="lbl">о чём эта книга</span>
      </header>
      <div className="fade-in" key={`about-${front.rev}`}>
        {paragraphs.map((paragraph, index) => (
          <p className="p" key={index}>
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  );
}
