import { AUTHOR_COLORS, type CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Discussion } from './Discussion.tsx';

/** Every stylesheet as text: the ink classes are an invariant of the sheet, not of a snapshot. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

function render(comments: readonly CommentDto[]): string {
  return renderToStaticMarkup(<Discussion depth={0} comments={comments} />);
}

/** The ink rules a stylesheet declares: class slot → colour. */
function inkRules(css: string): Array<{ slot: string; color: string }> {
  return [...css.matchAll(/\.comment-author\.author-ink-(\d+)\s*\{\s*color:\s*(#[0-9a-f]{6});/gu)].map(
    (match) => ({ slot: match[1] ?? '', color: match[2] ?? '' }),
  );
}

/**
 * BOOK-30 — the author colour travels as a class per palette slot, never as a style
 * attribute: the markup holds no colour value, and a slot is themeable from the sheet.
 */
describe('the author ink on the thread', () => {
  it('gives two readers two different classes, and names no colour in the markup', () => {
    const html = render([
      comment({ id: 'cmt_1', author: 'Аня', authorColor: AUTHOR_COLORS[0] }),
      comment({ id: 'cmt_2', author: 'Борис', authorColor: AUTHOR_COLORS[1] }),
    ]);
    expect(html).toContain('class="comment-author author-ink-0"');
    expect(html).toContain('class="comment-author author-ink-1"');
    expect(html).toContain('>Аня<');
    expect(html).toContain('>Борис<');
    // No colour value and no style attribute anywhere in the rendered thread.
    expect(html).not.toMatch(/style=/u);
    for (const color of AUTHOR_COLORS) expect(html).not.toContain(color);
  });

  it('keeps a reader separated by name when the stored colour is unknown', () => {
    const html = render([
      comment({ id: 'cmt_1', author: 'Аня', authorColor: '#2e6274' }),
      comment({ id: 'cmt_2', author: 'Вера', authorColor: '#2e6274' }),
    ]);
    expect(html).toContain('class="comment-author author-ink-3"');
    expect(html).toContain('class="comment-author author-ink-2"');
    expect(html).toContain('>Аня<');
    expect(html).toContain('>Вера<');
  });

  it('has exactly one stylesheet rule per palette slot, with the palette colour', () => {
    const rules = Object.values(sheets).flatMap((css) => inkRules(css));
    expect(rules).toHaveLength(AUTHOR_COLORS.length);
    expect(rules.map((rule) => rule.slot)).toEqual(AUTHOR_COLORS.map((_, slot) => String(slot)));
    expect(rules.map((rule) => rule.color)).toEqual([...AUTHOR_COLORS]);
  });
});

/**
 * BOOK-59 — the two counters of the register. A bare «обсуждение 4» is a number without its
 * noun, and «в очереди 3» could be read as three chapters; both now carry the word they count.
 */
describe('the register’s counters', () => {
  /** Read as a reader reads it: tags stripped, so a `<b>` between number and noun is no alibi. */
  function text(html: string): string {
    return html.replace(/<[^>]*>/gu, '');
  }

  it('names what each number counts, in the form the number asks for', () => {
    const html = renderToStaticMarkup(
      <Discussion depth={3} comments={[comment({ id: 'cmt_1' }), comment({ id: 'cmt_2' })]} />,
    );
    expect(text(html)).toContain('2 замечания');
    expect(text(html)).toContain('в очереди 3 правки');
  });

  it('uses the singular and the plural count forms', () => {
    expect(text(renderToStaticMarkup(<Discussion depth={1} comments={[comment({ id: 'cmt_1' })]} />))).toContain(
      '1 замечание',
    );
    expect(text(renderToStaticMarkup(<Discussion depth={1} comments={[]} />))).toContain('в очереди 1 правка');
    expect(text(renderToStaticMarkup(<Discussion depth={5} comments={[]} />))).toContain('в очереди 5 правок');
  });

  it('keeps the empty register quiet without naming a «замечание» as a premise', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[]} />);
    expect(html).not.toContain('Глав ещё нет');
    expect(html).not.toContain('станет её замыслом');
  });
});

/**
 * BOOK-DOC-43 §10 — a count of zero is a claim, printed before the feed answered (BOOK-66).
 *
 * The register's two feeds settle together (`useReaderFeed.threadSettled`), so this surface
 * receives one stage: while it waits the meta slot says what is happening, the body holds the
 * form of three rows, and the empty-state fine print stays off the page. A failure settles to
 * `quiet` — the thread is a view and has no retry of its own.
 */
describe('the register while its feed is landing', () => {
  function markup(comments: readonly CommentDto[], stage: 'quiet' | 'skeleton' | 'slow'): string {
    return renderToStaticMarkup(<Discussion depth={0} stage={stage} comments={comments} />);
  }

  it('says what is loading instead of «0 замечаний», and holds the form of three rows', () => {
    const html = markup([], 'skeleton');
    expect(html).toContain('замечания читаются');
    expect(html).toContain('class="skel skel-register"');
    expect(html).toContain('aria-busy="true"');
    // The false facts of §10: a count of nothing and a teaching line about rows that are not there.
    expect(html).not.toContain('0 замечаний');
    expect(html).not.toContain('Их читают как данные');
    expect(html).not.toContain('class="comments"');
    // Exactly one status, and it sits in the meta slot the surface already has.
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    expect(html).toMatch(/<span class="sec-meta"><span role="status"/u);
    // The queue line has its own, already-settled source: it is not a second waiting claim.
    expect(html).toContain('в очереди <b>0</b> правок');
  });

  it('carries the slow sentence in the same slot, still without the count', () => {
    const html = markup([], 'slow');
    expect(html).toContain('замечания идут дольше обычного · строки появятся здесь же');
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    expect(html).not.toContain('0 замечаний');
  });

  it('goes back to the count when the feed lands: no status, no form, no busy claim', () => {
    const html = markup([comment()], 'quiet');
    expect(html).toContain('1 замечание');
    expect(html).toContain('class="comments"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('aria-busy');
  });

  it('is busy for the whole request, not from the 150 ms sentence (§7 alignment)', () => {
    // The attribute is the wait's fact; the sentence is what the reader sees of it. Before the
    // threshold the register is busy and says nothing — the same rule ChapterArticle follows.
    const html = renderToStaticMarkup(<Discussion depth={0} stage="quiet" busy comments={[]} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    // Settled: the claim is removed, not set to «false».
    const settled = renderToStaticMarkup(<Discussion depth={0} stage="quiet" busy={false} comments={[]} />);
    expect(settled).not.toContain('aria-busy');
  });

  it('is silent after a failure: no status, no form, the settled-empty line stands', async () => {
    // A failure settles to `quiet`; nothing on this surface may keep waiting after it — and a
    // wait is the only state that shows the form, so the pair below proves the settle matters.
    // The app's two feeds settle together (`Promise.allSettled` in `useReaderFeed`), so a
    // rejection lands as a settled thread: `usePending(!threadSettled)` returns `quiet`.
    const settled = await Promise.allSettled([Promise.reject(new Error('changes')), Promise.reject(new Error('comments'))]);
    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    const stage = settled.every((outcome) => outcome.status === 'fulfilled') ? 'skeleton' : 'quiet';
    expect(stage).toBe('quiet');

    // While the feeds are in flight the surface does show the form; the settle is what removes it.
    const waiting = markup([], 'skeleton');
    expect(waiting).toContain('замечания читаются');
    expect(waiting).toContain('class="skel skel-register"');
    expect(waiting).toContain('role="status"');

    const html = markup([], stage);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('aria-busy');
    // Still the register, not a blank slot: the settled-empty teaching line stands.
    expect(html).toContain('class="page talks');
    expect(html).toContain('Их читают как данные');
    expect(html).not.toBe(waiting);
  });
});
