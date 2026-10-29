import { AUTHOR_COLORS, FAILED_ATTEMPT_LINE, type ChangeSummaryDto, type CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { queueLabel } from '../lib/format.ts';
import { STATE_LINES, STATE_WORDS } from '../lib/marginalia.ts';
import { Discussion } from './Discussion.tsx';
import { firstDeclarations } from './cssRules.ts';

/** Every stylesheet as text: the ink classes are an invariant of the sheet, not of a snapshot. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

let filed = 0;

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  filed += 1;
  return {
    id: 'cmt_1',
    // BOOK-218 — the filing's own number; the counter keeps the rows of one list distinct.
    number: filed,
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

function render(comments: readonly CommentDto[]): string {
  return renderToStaticMarkup(<Discussion depth={0} comments={comments} live />);
}

/**
 * BOOK-199 (audit #21) — one ink for people. Six colours for six readers measured 1.98–2.41:1 on
 * the day paper and named nothing a reader could use: identity is the name, and a reader's own
 * filing is marked by the word `ваше`. The stored `authorColor` remains on the wire; the sheet
 * no longer paints it, so no slot class and no hex may reach the markup.
 */
describe('the author ink on the thread', () => {
  it('prints every name in the one class, with no colour value in the markup', () => {
    const html = render([
      comment({ id: 'cmt_1', author: 'Аня', authorColor: AUTHOR_COLORS[0] }),
      comment({ id: 'cmt_2', author: 'Борис', authorColor: AUTHOR_COLORS[1] }),
    ]);
    expect(html).toContain('class="comment-author"');
    expect(html).toContain('>Аня<');
    expect(html).toContain('>Борис<');
    // No colour value, no style attribute and no palette slot anywhere in the thread.
    expect(html).not.toMatch(/comment-author\s/u);
    expect(html).not.toMatch(/style=/u);
    for (const color of AUTHOR_COLORS) expect(html).not.toContain(color);
  });

  it('keeps the two readers apart by name, whatever colour a row stores', () => {
    const html = render([
      comment({ id: 'cmt_1', author: 'Аня', authorColor: '#2e6274' }),
      comment({ id: 'cmt_2', author: 'Вера', authorColor: '#2e6274' }),
    ]);
    expect(html).not.toMatch(/comment-author\s/u);
    expect(html).toContain('>Аня<');
    expect(html).toContain('>Вера<');
  });

  it('gives the name the sheet’s one ink — no slot rules left to paint', () => {
    // No compound `.comment-author.<slot>` rule survives: the name has one class, one ink.
    for (const css of Object.values(sheets)) expect(css).not.toMatch(/\.comment-author\./u);
    const rule = firstDeclarations(sheets['../styles/book.css'] ?? '', '.comment-author');
    expect(rule).toContain('color: var(--ink)');
    expect(rule).toContain('font-size: var(--fs-micro)');
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});

/**
 * BOOK-156 (#3802 §3) — the register's public anchors. The section is named `#discussion`
 * (the owner's word for it) and the old `#talks` deep link still has to land in the same
 * place: a public anchor is a promise, so both are stated and tested.
 */
describe('the register’s two anchors', () => {
  it('states id="discussion" and keeps a zero-height #talks at the same head', () => {
    const html = render([]);
    expect(html).toContain('class="page talks ym-hide-content" id="discussion"');
    expect(html).toContain('<span id="talks" aria-hidden="true"></span>');
    // The legacy anchor is inside the register, not a second section beside it.
    expect(html.indexOf('id="talks"')).toBeGreaterThan(html.indexOf('id="discussion"'));
  });
});

/**
 * BOOK-59 / BOOK-70 — the two counters of the register. A bare «обсуждение 4» is a number
 * without its noun, «в работе 3» could be read as three chapters, and a chip never counts
 * nothing: the zero states are sentences («замечаний нет», «правок в работе нет»).
 */
describe('the register’s counters', () => {
  /** Read as a reader reads it: tags stripped, so a `<b>` between number and noun is no alibi. */
  function text(html: string): string {
    return html.replace(/<[^>]*>/gu, '');
  }

  it('names what each number counts, in the form the number asks for', () => {
    const html = renderToStaticMarkup(
      <Discussion
        depth={3}
        complete
        comments={[comment({ id: 'cmt_1' }), comment({ id: 'cmt_2' }), comment({ id: 'cmt_3' })]}
        live
      />,
    );
    expect(text(html)).toContain('3 замечания');
    expect(text(html)).toContain(queueLabel(3));
    expect(text(html)).toContain('в работе 3 правки');
  });

  it('prints the reader’s own place from the snapshot’s pending list, not from a poll', () => {
    const mine = comment({ id: 'cmt_1', changeId: 'chg_2', status: 'accepted' });
    const html = renderToStaticMarkup(
      <Discussion
        depth={3}
        complete
        comments={[mine]}
        pending={[
          { id: 'chg_2', chapter: 4, seq: 2, ahead: 2, kind: 'edit', enqueuedAt: '2026-10-29T10:00:00Z' },
        ]}
        live
      />,
    );
    expect(text(html)).toContain('впереди 2');
    // BOOK-220 m5 — a change that is next says so: «впереди 0» is not a place a reader is in.
    const next = renderToStaticMarkup(
      <Discussion
        depth={3}
        complete
        comments={[mine]}
        pending={[
          { id: 'chg_2', chapter: 4, seq: 2, ahead: 0, kind: 'edit', enqueuedAt: '2026-10-29T10:00:00Z' },
        ]}
        live
      />,
    );
    expect(text(next)).toContain('ваша правка — следующая');
    expect(text(next)).not.toContain('впереди 0');
    // Nothing waiting of the reader's own: the queue's own line stands.
    const other = renderToStaticMarkup(
      <Discussion depth={1} comments={[]} pending={[{ id: 'chg_9', chapter: 4, seq: 1, ahead: 0, kind: 'edit', enqueuedAt: '2026-10-29T10:00:00Z' }]} live />,
    );
    expect(text(other)).toContain('правки идут по одной');
  });

  it('uses the singular and the plural count forms', () => {
    expect(
      text(renderToStaticMarkup(<Discussion depth={1} complete comments={[comment({ id: 'cmt_1' })]} live />)),
    ).toContain('1 замечание');
    expect(text(renderToStaticMarkup(<Discussion depth={1} comments={[]} live />))).toContain('в работе 1 правка');
    expect(text(renderToStaticMarkup(<Discussion depth={5} comments={[]} live />))).toContain(queueLabel(5));
    expect(text(renderToStaticMarkup(<Discussion depth={5} comments={[]} live />))).toContain('в работе 5 правок');
  });

  it('splits the stamp: a comment’s moment is a stamp-time, never the old shared `.stamp`', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[comment({ id: 'cmt_1' })]} live />);
    expect(html).toContain('class="stamp-time"');
    expect(html).not.toContain('class="stamp"');
  });

  it('states the zeros as sentences, never as counts of nothing', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} complete comments={[]} live />);
    expect(text(html)).toContain('замечаний нет');
  });

  it('a failed read is not an empty thread: it says so, and the empty state is not printed', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} failed comments={[]} live />);
    expect(text(html)).toContain('не удалось прочитать обсуждение');
    expect(text(html)).not.toContain('замечаний нет');
    // The teaching line belongs to a settled empty feed, not to a read that never answered.
    expect(text(html)).not.toContain('Их читают как данные');
    expect(text(html)).toContain(queueLabel(0));
    expect(text(html)).toContain('правок в работе нет');
    for (const wrong of ['0 замечаний', 'в работе 0', '0 правок', '0 правка']) expect(text(html), wrong).not.toContain(wrong);
  });

  /**
   * BOOK-128 #3900 §1 — a count is honest only over a complete feed. The API has no total, so
   * `complete` is `nextBefore === null`; without it the register prints no number at all and
   * the label «обсуждение» stands alone. The default is the safe one: a caller that does not
   * know says nothing.
   */
  it('prints no number over a partial page, and the label stands alone', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[comment({ id: 'cmt_1' })]} live />);
    const plain = text(html);
    expect(plain).not.toContain('1 замечание');
    expect(plain).not.toContain('замечание');
    expect(plain).toContain('обсуждение');
    // The empty label alone, with no zero sentence either: the page is a window, not a total.
    const empty = text(renderToStaticMarkup(<Discussion depth={0} comments={[]} live />));
    expect(empty).not.toContain('замечаний нет');
    // The row itself is still printed: only the count is withheld.
    expect(html).toContain('class="comments"');
    expect(html).toContain('data-comment-id="cmt_1"');
  });

  it('prints the count over a complete page, zero included as a sentence', () => {
    const one = text(renderToStaticMarkup(<Discussion depth={0} complete comments={[comment({ id: 'cmt_1' })]} live />));
    expect(one).toContain('1 замечание');
    const none = text(renderToStaticMarkup(<Discussion depth={0} complete comments={[]} live />));
    expect(none).toContain('замечаний нет');
  });

  it('replaces the withheld count with the status sentence while the feed waits', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} stage="skeleton" comments={[]} live />);
    expect(html).toContain('замечания читаются');
    expect(html).not.toContain('замечаний нет');
    expect(html.match(/role="status"/gu)).toHaveLength(1);
  });

  it('keeps the empty register quiet without naming a «замечание» as a premise', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[]} live />);
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
    return renderToStaticMarkup(<Discussion depth={0} stage={stage} comments={comments} live />);
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
    // The queue line has its own, already-settled source: it is not a second waiting claim,
    // and at zero it is a sentence, not a count of nothing (BOOK-70).
    expect(html).toContain(queueLabel(0));
  });

  it('carries the slow sentence in the same slot, still without the count', () => {
    const html = markup([], 'slow');
    expect(html).toContain('замечания идут дольше обычного · строки появятся здесь же');
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    expect(html).not.toContain('0 замечаний');
  });

  it('goes back to the count when the feed lands: no status, no form, no busy claim', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} stage="quiet" complete comments={[comment()]} live />);
    expect(html).toContain('1 замечание');
    expect(html).toContain('class="comments"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('aria-busy');
  });

  it('is busy for the whole request, not from the 150 ms sentence (§7 alignment)', () => {
    // The attribute is the wait's fact; the sentence is what the reader sees of it. Before the
    // threshold the register is busy and says nothing — the same rule ChapterArticle follows.
    const html = renderToStaticMarkup(<Discussion depth={0} stage="quiet" busy comments={[]} live />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    // Settled: the claim is removed, not set to «false».
    const settled = renderToStaticMarkup(<Discussion depth={0} stage="quiet" busy={false} comments={[]} live />);
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

/** A change summary, only the fields the register reads. */
function change(overrides: Partial<ChangeSummaryDto> = {}): ChangeSummaryDto {
  return {
    premiseLanded: false,
    sourceCommentId: 'cmt_1',
    id: 'chg_1',
    seq: 1,
    chapter: 65,
    intent: 'ответ на вопрос дать процедурой, а не объяснением',
    premise: false,
    status: 'pending',
    frame: 'untouched',
    frameMode: null,
    outcome: null,
    reason: null,
    position: 1,
    enqueuedAt: '2026-10-25T11:00:00Z',
    decidedAt: null,
    chapters: [65],
    rewritten: [],
    steps: 0,
    modes: [],
    cascade: null,
    ...overrides,
  };
}

/** Tags stripped, so a `<b>` between a number and its noun is no alibi. */
function text(html: string): string {
  return html.replace(/<[^>]*>/gu, '');
}

/**
 * One filing is one entry: a premise is the chapter's row (never a block here), and a change
 * is the attempt of the filing it came from (never a second row). The prod page said «в
 * ждёт своей главы» over two rows it presented as waiting, and showed the same premise twice: as
 * a filing and as the chapter's row.
 */
describe('one state per filing on the register', () => {
  it('lists the thread’s filings only; the queue is the writer’s, never the rows', () => {
    // BOOK-189 — the line counts the writer's pending changes (`depth`), and the rows are what
    // the page lists. The premise here is a row of the chapter's own, never a queue place.
    const html = renderToStaticMarkup(
      <Discussion
        depth={1}
        complete
        comments={[
          // A premise whose chapter 65 has text: it entered the first edition, and its home is
          // the chapter's own row — the thread prints no block for it.
          comment({
            id: 'cmt_65',
            number: 3,
            chapter: 65,
            premise: true,
            status: 'applied',
            applied: { chapter: 65, rev: 7 },
          }),
          // A filing still in triage: one queued entry, and the line must count it.
          comment({ id: 'cmt_9', chapter: 9, status: 'new' }),
        ]}
        changes={[
          // The premise as its own change: an attempt inside the entry, never a row.
          change({ id: 'chg_65', premise: true, premiseLanded: true, status: 'done', outcome: 'applied', sourceCommentId: 'cmt_65' }),
        ]}
        live
      />,
    );
    const plain = text(html);
    expect(plain).toContain('ждёт');
    expect(plain).toContain(queueLabel(1));
    expect(plain).not.toContain(queueLabel(0));
    // The premise's word is its row's, not the thread's: one entry, one state, no duplicate.
    expect(plain).not.toContain('внесено');
    expect(plain).toContain('1 замечание');
    expect(html).not.toContain('data-comment-id="cmt_65"');
    expect(html).toContain('data-comment-id="cmt_9"');
    // One queued entry = one filing; the premise change is not a row of its own.
    expect(html).not.toContain('data-change="chg_65"');
    expect(html.match(/class="talk tone-/gu) ?? []).toHaveLength(0);
  });

  it('shows a failed attempt as the deck’s sentence, never as the engine’s code', () => {
    const html = renderToStaticMarkup(
      <Discussion
        depth={1}
        comments={[comment({ id: 'cmt_9', chapter: 9, status: 'new', attempt: 'failed' })]}
        live
      />,
    );
    expect(text(html)).toContain(FAILED_ATTEMPT_LINE);
    expect(text(html)).toContain(queueLabel(1));
    expect(html).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
  });

  it('prints one state per filing: landed over an older attempt, pending, refused (BOOK-189)', () => {
    // The owner's rows: one filing whose `change_id` pointed at an older `escalated` attempt while
    // a later `done applied` landed it, one the lane still holds, one refused. The queue line is
    // the writer's (`depth`), so one pending change reads «в работе 1 правка» over three rows.
    const html = renderToStaticMarkup(
      <Discussion
        depth={1}
        complete
        comments={[
          comment({
            id: 'cmt_applied',
            number: 4,
            status: 'applied',
            chapter: 3,
            applied: { chapter: 3, rev: 4 },
            changeId: 'chg_applied',
            reason: null,
            attempt: null,
          }),
          comment({ id: 'cmt_pending', status: 'accepted', changeStatus: 'pending', changeId: 'chg_pending' }),
          comment({
            id: 'cmt_refused',
            number: 5,
            status: 'rejected',
            refusal: 'auditor',
            reason: 'вне книги: этот мир не просит чудес',
          }),
        ]}
        changes={[
          change({
            id: 'chg_escalated',
            seq: 1,
            status: 'escalated',
            outcome: 'gate_timeout',
            reason: 'движок отказал: ENGINE_TIMEOUT',
            sourceCommentId: 'cmt_applied',
          }),
          change({
            id: 'chg_applied',
            seq: 2,
            status: 'done',
            outcome: 'applied',
            sourceCommentId: 'cmt_applied',
            decidedAt: '2026-10-25T12:30:00Z',
          }),
        ]}
        live
      />,
    );
    const plain = text(html);
    expect(plain).toContain('внесено');
    expect(plain).toContain('в главу 3. это четвёртая редакция');
    // BOOK-218 — `accepted` with no change in hand is one row: the word and its one line.
    expect(plain).toContain(STATE_WORDS.accepted);
    expect(plain).toContain(STATE_LINES.accepted);
    // BOOK-218 — two sinks, one word each: a refusal says `не принято`.
    expect(plain).toContain('не принято');
    expect(plain).toContain('вне книги: этот мир не просит чудес');
    expect(plain).toContain(queueLabel(1));
    // The failed attempt is history, not the state: no machinery word, no second landing claim.
    expect(plain).not.toContain('идёт');
    expect(plain).not.toContain('в очереди');
    expect(plain).not.toContain('впишется 4-й');
    expect(plain).not.toContain('входит в книгу');
    expect(html).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
  });

  it('an empty queue is one sentence and no list', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} complete comments={[]} changes={[]} live />);
    const plain = text(html);
    expect(plain).toContain(queueLabel(0));
    expect(plain).toContain('замечаний нет');
    expect(html).not.toContain('class="talks-list"');
    expect(html).not.toContain('class="comment"');
    expect(html).not.toContain('class="talk ');
  });
});
