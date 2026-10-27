// @vitest-environment jsdom
import type {
  AuthorsDto,
  ChangeDto,
  CommentDto,
  HistoryRecordDto,
  MyTraceDto,
  ParagraphChainDto,
} from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Authors } from './Authors.tsx';
import { ChangeCard } from './ChangeCard.tsx';
import { Chronicle } from './Chronicle.tsx';
import { FilingPanel } from './FilingPanel.tsx';
import { MarginNote } from './MarginNote.tsx';
import { ParagraphChain } from './ParagraphChain.tsx';
import { PremiseRow } from './PremiseRow.tsx';
import { ProvenancePanel } from './ProvenancePanel.tsx';
import { RecordRow } from './RecordRow.tsx';
import { MIDDOT } from '../lib/format.ts';
import { RevisionObject } from './RevisionObject.tsx';
import type { ProvenanceView } from '../lib/provenance.ts';

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

const OWN_TRACE: MyTraceDto = {
  label: SENTINEL.name,
  edits: 2,
  chars: 400,
  share: 0.004,
  series: [],
  hidden: false,
  survivedRevisions: 4,
};

const COMMENT: CommentDto = {
  id: 'cmt_1',
  chapter: 8,
  anchor: { blockId: 'ch08#aa11bb22', blockIndex: 3, quote: SENTINEL.quote, prefix: null, suffix: null, resolved: true },
  author: SENTINEL.name,
  authorColor: 'ink-a',
  body: SENTINEL.body,
  proposedText: null,
  interventionKind: 'document',
  status: 'new',
  premise: false,
  reason: null,
  createdAt: '2026-10-25T12:00:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
      refusal: null,
};

const CHANGE: ChangeDto = {
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

const VIEW: ProvenanceView = {
  title: 'откуда это слово',
  word: 'фонарь',
  chapterLine: 'глава 08',
  chain: [{ label: 'написано', value: `правка 3 · ${SENTINEL.name}` }],
  rows: [{ label: 'след', value: `доля ${SENTINEL.name}` }],
  copy: null,
  action: { kind: 'rules', label: 'правила' },
};

const RECORD: HistoryRecordDto = {
  hseq: 42,
  at: '2026-10-25T12:05:00Z',
  seq: 7,
  chapter: 8,
  premise: false,
  alias: SENTINEL.name,
  status: 'done',
  outcome: 'applied',
  reason: null,
  changeId: 'chg_1',
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
  it('masks the authors list, including the reader’s own trace in it', () => {
    const html = renderToStaticMarkup(
      <Authors authors={AUTHORS} imprint={IMPRINT} lastRevisionAt={null} ownTrace={OWN_TRACE} live />,
    );
    expectMasked(html, SENTINEL.name, '.authors');
    // Two rows carry the same name (the list and «ваш след»): both are under the mask.
    expect(html).toContain('ym-hide-content');
    // And the identity rows are out of the clickmap as well.
    expect(html).toContain('authors-row ym-disable-clickmap');
    expect(html).toContain('own-trace ym-disable-clickmap');
  });

  it('masks the change card: the intent and the reader it came from', () => {
    const html = renderToStaticMarkup(<ChangeCard change={CHANGE} onClose={() => undefined} />);
    expectMasked(html, SENTINEL.intent, '.change-card');
    expectMasked(html, `из замечания ${SENTINEL.name}`, '.change-card');
  });

  it('masks the filing panel: the author, the quote and the body', () => {
    const html = renderToStaticMarkup(<FilingPanel comment={COMMENT} anchor={null} onClose={() => undefined} />);
    expectMasked(html, SENTINEL.name, '.filing-panel');
    expectMasked(html, SENTINEL.quote, '.filing-panel');
    expectMasked(html, SENTINEL.body, '.filing-panel');
  });

  it('masks the margin note: the author and the quoted sentence', () => {
    const html = renderToStaticMarkup(<MarginNote comment={COMMENT} onOpen={() => undefined} />);
    expectMasked(html, SENTINEL.name, '.margin-note');
    expectMasked(html, SENTINEL.quote, '.margin-note');
  });

  it('masks the revision object: the name, the quote and the body', () => {
    const html = renderToStaticMarkup(
      <RevisionObject comment={COMMENT} text={SENTINEL.quote} onClose={() => undefined} />,
    );
    expectMasked(html, SENTINEL.name, '.revision');
    expectMasked(html, SENTINEL.quote, '.revision');
    expectMasked(html, SENTINEL.body, '.revision');
  });

  it('masks the provenance panel’s chain and rows', () => {
    const html = renderToStaticMarkup(<ProvenancePanel view={VIEW} anchor={null} onClose={() => undefined} />);
    expectMasked(html, `правка 3 · ${SENTINEL.name}`, '.prov-panel');
    expectMasked(html, `доля ${SENTINEL.name}`, '.prov-panel');
  });

  it('masks the chronicle and every record row, aria-label included', () => {
    const section = renderToStaticMarkup(
      <Chronicle catalog={[]} frontRev={1} tick={0} onOpenChange={() => undefined} started live />,
    );
    expect(section).toContain('chronicle');
    expect(section).toContain('ym-hide-content');

    const row = renderToStaticMarkup(<RecordRow record={RECORD} onOpenChange={() => undefined} />);
    // The alias is a reader's display name and the row is reader-facing copy; BOOK-DOC-50 dates
    // the label, so the accessible name opens with the record's own moment.
    expectMasked(row, SENTINEL.name, '.chr-row');
    expect(row).toContain(`aria-label="25.10.2026${MIDDOT}15:05, правка 7, глава 8, ${SENTINEL.name}, внесено — открыть карточку правки"`);
  });

  it('masks the paragraph chain, which names the reader who wrote each version', () => {
    const html = renderToStaticMarkup(
      <ParagraphChain
        chain={CHAIN}
        loading={false}
        failed={false}
        onClose={() => undefined}
        onRetry={() => undefined}
        live
      />,
    );
    expectMasked(html, SENTINEL.name, '.chain');
    expectMasked(html, `правкой 7 (${SENTINEL.name})`, '.chain');
  });

  it('masks a filled premise slot, which shows the premise’s own first line', () => {
    const html = renderToStaticMarkup(
      <PremiseRow
        row={{ n: 2, quote: SENTINEL.body, word: 'ждёт', actionable: true }}
        onOpen={() => undefined}
      />,
    );
    expectMasked(html, SENTINEL.body, '.premise');
  });

  it('keeps the mask on the container, not on the text of a single field', () => {
    // A mask on an inner <span> would leave the container's own text (the quote around it) open.
    const html = renderToStaticMarkup(<FilingPanel comment={COMMENT} anchor={null} onClose={() => undefined} />);
    const node = holder(html, SENTINEL.body);
    expect(node.className).not.toContain('ym-hide-content');
    expect(node.parentElement?.className).toContain('ym-hide-content');
  });
});
