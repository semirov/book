// @vitest-environment jsdom
import type {
  AuthorsDto,
  ChangeDto,
  CommentDto,
  HistoryRecordDto,
  ParagraphChainDto,
} from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Authors } from './Authors.tsx';
import { ChangeSection } from './ChangeSection.tsx';
import { Chronicle } from './Chronicle.tsx';
import { FilingCard } from './FilingCard.tsx';
import { MarginNote } from './MarginNote.tsx';
import { PremiseRow } from './PremiseRow.tsx';
import { ProvenanceBlock } from './ProvenanceBlock.tsx';
import { SentenceBlock } from './SentenceBlock.tsx';
import { RecordRow } from './RecordRow.tsx';
import { MIDDOT } from '../lib/format.ts';
import type { WordFacts } from '../lib/provenance.ts';

/**
 * BOOK-77 (audit F1) — the consent line says «Текст и имя в неё не попадают».
 *
 * Webvisor records the DOM; the one thing that keeps a block out of the recording is
 * `ym-hide-content` on the element that holds it. This test does not read class strings: it
 * renders each surface with a sentinel, finds the element that actually holds the reader's
 * words or name in the markup, and requires a masked ancestor. A surface that ships without
 * one fails here instead of contradicting the consent screen on the live site.
 */

const SENTINEL = {
  name: 'Зоя Испытательница',
  intent: 'в этом абзаце дважды «фонарь» — оставить один',
  body: 'смотритель оставляет фонарь у двери и не возвращается',
  quote: 'у двери стоял фонарь',
  summary: 'глава 8 переписана правкой 7 (Зоя Испытательница)',
};

/** The element that holds `text` in the rendered markup, or a failure that names the text. */
function holder(html: string, text: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  for (const node of host.querySelectorAll('*')) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && (child.textContent ?? '').includes(text)) return node;
    }
  }
  throw new Error(`no element holds «${text}»`);
}

/** The reader text must sit inside a container Webvisor is told to skip. */
function expectMasked(html: string, text: string, container: string): void {
  const node = holder(html, text);
  const masked = node.closest('.ym-hide-content');
  expect(masked, `«${text}» has no ym-hide-content ancestor`).not.toBeNull();
  // The mask is on the surface the reader is looking at, not on an unrelated wrapper.
  expect(node.closest(container), `«${text}» is outside ${container}`).not.toBeNull();
}

const IMPRINT = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };

const AUTHORS: AuthorsDto = {
  totalChars: 100_000,
  measuredAt: '2026-10-25T12:00:00Z',
  measured: 1,
  author: { label: 'Филипп Семиров', share: 0.9, chars: 90_000 },
  contributors: [{ identityId: 'idt_1', label: SENTINEL.name, edits: 2, chars: 10_000, share: 0.1, firstAt: '2026-10-01T09:00:00Z' }],
  sum: 1,
};


const COMMENT: CommentDto = {
  attempt: null,
  id: 'cmt_1',
  chapter: 8,
  anchor: { blockId: 'ch08#aa11bb22', blockIndex: 3, quote: SENTINEL.quote, prefix: null, suffix: null, resolved: true },
  author: SENTINEL.name,
  authorColor: 'ink-a',
  body: SENTINEL.body,
  proposedText: null,
  interventionKind: 'document',
  status: 'new',
  frame: 'untouched',
  premise: false,
  reason: null,
  createdAt: '2026-10-25T12:00:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
      refusal: null,
};

const CHANGE: ChangeDto = {
  premiseLanded: false,
  id: 'chg_1',
  seq: 7,
  kind: 'accepted_comment',
  interventionKind: 'document',
  chapter: 8,
  intent: SENTINEL.intent,
  premise: false,
  source: { commentId: 'cmt_1', author: SENTINEL.name },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: null,
  cascade: null,
  steps: [],
  appliedRevs: [],
  cost: null,
  scienceCheck: null,
  modes: [],
  history: { fromHseq: 10, toHseq: 14 },
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

/** BOOK-128 comment #3815 — the word's block prints the hand, which may be a reader's name. */
const FACTS: WordFacts = {
  hand: SENTINEL.name,
  when: 'с 25.10.2026, 15:05',
  trace: 'пережила 4 ревизии',
  gloss: null,
  filing: null,
};

const RECORD: HistoryRecordDto = {
  id: 'chg_1',
  hseq: 42,
  at: '2026-10-25T12:05:00Z',
  seq: 7,
  chapter: 8,
  chapterTitle: null,
  premise: false,
  premiseLanded: false,
  alias: SENTINEL.name,
  cause: 'reader',
  status: 'done',
  outcome: 'applied',
  reason: null,
  changeId: 'chg_1',
  recordHref: '?change=chg_1',
  span: null,
};

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  line: `переписано в 14:20 правкой 7 (${SENTINEL.name})`,
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 2,
      blockId: 'ch08#0b7e9c31',
      chapter: 8,
      rev: 5,
      at: '2026-10-25T11:20:00Z',
      op: 'revised',
      textHash: '0b7e9c31',
      chars: 112,
      changeId: 'chg_7',
      changeSeq: 7,
      stepId: 'stp_2',
      actor: { kind: 'reader', identityId: 'idt_2', label: SENTINEL.name },
      replacedBy: null,
    },
  ],
};

describe('the reader’s name and words are masked from Webvisor', () => {
  it('masks the authors list; the reader’s own trace left for its own masked page', () => {
    const html = renderToStaticMarkup(
      <Authors authors={AUTHORS} imprint={IMPRINT} lastRevisionAt={null} live />,
    );
    expectMasked(html, SENTINEL.name, '.authors');
    expect(html).toContain('ym-hide-content');
    // The identity rows are out of the clickmap as well.
    expect(html).toContain('authors-row ym-disable-clickmap');
    // BOOK-207: `#след` owns the trace and carries its own mask; this block keeps one row.
    expect(html).toContain('href="#след"');
    expect(html).not.toContain('own-trace');
  });

  it('masks the record’s change section: the filing’s quote and the author’s words', () => {
    const html = renderToStaticMarkup(<ChangeSection change={CHANGE} before={SENTINEL.quote} after={null} />);
    expectMasked(html, SENTINEL.quote, '.rec-change');
  });

  it('masks the filing panel: the author, the quote and the body', () => {
    const html = renderToStaticMarkup(<FilingCard comment={COMMENT} onClose={() => undefined} />);
    expectMasked(html, SENTINEL.name, '.filing-panel');
    expectMasked(html, SENTINEL.quote, '.filing-panel');
    expectMasked(html, SENTINEL.body, '.filing-panel');
  });

  it('masks the margin note: the author and the quoted sentence', () => {
    const html = renderToStaticMarkup(<MarginNote comment={COMMENT} onOpen={() => undefined} />);
    expectMasked(html, SENTINEL.name, '.margin-note');
    expectMasked(html, SENTINEL.quote, '.margin-note');
  });

  it('masks the word’s margin block, whose hand may be a reader’s name', () => {
    const html = renderToStaticMarkup(<ProvenanceBlock view={FACTS} failed={false} onFiling={() => undefined} />);
    expectMasked(html, SENTINEL.name, '.prov-block');
  });

  it('masks the chronicle and refuses to name a reader on a record row', () => {
    const section = renderToStaticMarkup(
      <Chronicle catalog={[]} frontRev={1} tick={0} started live />,
    );
    expect(section).toContain('chronicle');
    expect(section).toContain('ym-hide-content');

    const row = renderToStaticMarkup(<RecordRow record={RECORD} />);
    // The row prints the cause, the place and the book's own pair — never a reader's name, so
    // the promise holds by absence here: there is no alias on a record entry to mask.
    expect(row).toContain('class="chr-row ym-hide-content"');
    expect(row).not.toContain(SENTINEL.name);
    // BOOK-DOC-50 dates the label, so the accessible name opens with the record's own moment.
    expect(row).toContain(
      `aria-label="25.10.2026${MIDDOT}15:05, глава 8, правка читателя — открыть правку"`,
    );
  });

  it('masks the phrase’s block, and names the record rather than the reader in it', () => {
    const html = renderToStaticMarkup(
      <SentenceBlock
        chain={CHAIN}
        loading={false}
        failed={false}
        quote={SENTINEL.quote}
        frame="none"
        place="flow"
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
    // The layer prints the change's number, never the reader who made it — the name cannot leak
    // from a fact the block does not print, and the root is masked all the same.
    expect(html).toContain('правка · №7');
    expect(html).not.toContain(SENTINEL.name);
    expect(html).toContain('ym-hide-content');
    expectMasked(html, SENTINEL.quote, '.sentence-block');
  });

  it('masks a filled premise slot, which shows the premise’s own first line', () => {
    const html = renderToStaticMarkup(
      <PremiseRow
        row={{ n: 2, commentId: 'cmt_1', quote: SENTINEL.body, word: 'ждёт', note: null, reason: null, revise: null, attempt: null, actionable: true }}
        onOpen={() => undefined}
        onRevise={() => undefined}
      />,
    );
    expectMasked(html, SENTINEL.body, '.premise');
  });

  it('keeps the mask on the container, not on the text of a single field', () => {
    // A mask on an inner <span> would leave the container's own text (the quote around it) open.
    const html = renderToStaticMarkup(<FilingCard comment={COMMENT} onClose={() => undefined} />);
    const node = holder(html, SENTINEL.body);
    expect(node.className).not.toContain('ym-hide-content');
    expect(node.parentElement?.className).toContain('ym-hide-content');
  });
});
