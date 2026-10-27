import type { CatalogEntry, CommentDto, StateSnapshot, ViewerDto } from '@book/shared';
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ChapterArticle } from '../src/components/ChapterArticle.tsx';
import { Header } from '../src/components/Header.tsx';
import { MarginTail } from '../src/components/MarginTail.tsx';
import { ProseParagraph } from '../src/components/ProseParagraph.tsx';
import { Seam } from '../src/components/Seam.tsx';
import { EMPTY_COMPOSER } from '../src/lib/composer.ts';
import { emptyDraft, seamDrafts } from '../src/lib/draft.ts';
import { filingsForBlock } from '../src/lib/filings.ts';
import type { SeamAnchor } from '../src/lib/seam.ts';
import { PREMISE_HINT } from '../src/lib/premise.ts';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/running-head.css';
import '../src/styles/consent.css';
import '../src/styles/book.css';
import '../src/styles/live.css';
import '../src/styles/cascade.css';
import '../src/styles/ribbon.css';
import '../src/styles/chronicle.css';
import '../src/styles/focus.css';
import '../src/styles/seam.css';
import '../src/styles/panels.css';
import '../src/styles/seam-form.css';
import '../src/styles/marginalia.css';
import './fixture.css';

/**
 * BOOK-90 — the dev-only fixture for the marginalia, the empty chapter and the running head.
 *
 * The **real** components: `Header` with its `IntersectionObserver`, `ChapterArticle` for the
 * empty slots (one row, the hint on the first one only, the premise strip in flow), and the
 * prose with a pending note and a landed tick. The width alone decides which surface is
 * painted — the note at ≥1024, the strip at <1024 — because the components render both.
 *
 * `?before=1` renders the pre-change empty slot (big `ch-n`, meta line, label on the right,
 * the hint under every slot) for the comparison screenshot. Nothing here is linked from the
 * app; the production build has one input and never sees this file.
 *
 * `npm run dev -w @book/web` → http://127.0.0.1:5173/marginalia.html
 */

const VIEWER = { signedIn: false, displayName: null } as const;
const params = new URLSearchParams(window.location.search);
const before = params.has('before');
/** AC6: one frame holding the pending note, the landed change's object and the empty row. */
const final = params.has('final');
/** The strip's six states, one above the other, for the phone-form check. */
const strips = params.has('strips');

/**
 * The dev server has no engine behind `/api`: answer the fixture's one change locally, so the
 * object shows its real shape (wave · reach · door) and the console carries no failed request.
 */
const DEV_CHANGE = {
  id: 'chg_demo',
  seq: 14,
  chapter: 1,
  status: 'done',
  cascade: { wave: 2, modes: [] },
  steps: [],
  appliedRevs: [{ chapter: 1, rev: 4 }],
};
const fetchReal = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  if (url.endsWith('/api/comments')) {
    // The receipt state is a 201: the fixture answers it so the strip can be photographed
    // after a real submit.
    return Promise.resolve(
      new Response(
        JSON.stringify({
          comment: { id: 'cmt_01J9Z8K4Q7' },
          remaining: { perHour: 20, remaining: 19, resetAt: null, editsPerDay: 10, editsRemaining: 9 },
          queue: { depth: 0 },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  if (url.includes('/api/changes/chg_demo')) {
    return Promise.resolve(
      new Response(JSON.stringify(DEV_CHANGE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }
  return fetchReal(input, init);
}) as typeof window.fetch;

/** The fixture's block ids: a filing names one, and the paragraph it belongs to. */
const B1 = 'ch01#p1';
const B2 = 'ch01#p2';
const B3 = 'ch01#p3';
const B4 = 'ch02#p1';
const B5 = 'ch05#p1';

const P1 = 'Я вошёл в пустую комнату. Её освещал яркий свет. На столе лежал лист бумаги, и на нём не было ни строки.';
const P2 = 'Свет был включён до меня. Об этом никто не говорил. Я закрыл дверь и остался стоять в темноте.';
const P3 = 'Потом я понял, что свет не выключали. Он просто перестал быть нужен. Слово «потом» здесь лишнее.';
const P4 = 'В коридоре было тихо. Часы на стене показывали половину восьмого. Кто-то поднимался по лестнице.';
/** The landed change rewrote its sentence: the stored quote is the text as it was. */
const P2F = 'Я вошёл в пустую комнату. Свет был включён до меня и горел всю ночь. Об этом никто не говорил.';
const P5 = 'Я вернулся на лестницу. Свет уже не горел. Дверь была приоткрыта, и в комнате кто-то ждал.';

const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-27T12:00:00Z',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-27T10:00:00Z' },
  chapters: { total: 67, written: [1, 2], empty: [3, 4, 21], count: 2, totalChars: 24_000, basis: [] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 67, cursor: 2, next: 3, status: 'idle', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: 67, to: 1, cursor: 3, next: 2, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 2, backwardFront: 67, gap: 0, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 0,
    byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
};

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: 1,
    title: null,
    rev: 3,
    chars: 12_000,
    blocks: 3,
    written: true,
    basis: false,
    writtenAt: '2026-10-25T09:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
    direction: 'forward',
    ...overrides,
  };
}

function comment(overrides: Partial<CommentDto>): CommentDto {
  return {
    id: 'cmt_demo_001',
    chapter: 1,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: 'testimony',
    status: 'new',
    premise: false,
    reason: null,
    createdAt: '2026-10-25T12:04:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

const CH1 = entry(1, { title: 'Комната на восьмом' });
const CH2 = entry(2, { title: 'Свет до меня' });
const CH5 = entry(5, { title: 'Лестница' });
const emptyEntry = (n: number): CatalogEntry => entry(n, { written: false, blocks: 0, chars: 0, title: null, rev: 0 });

const COMMENTS: CommentDto[] = [
  // The pending note: alive, waiting — a numeral in the text and a note in the margin.
  comment({
    id: 'cmt_demo_001',
    chapter: 1,
    anchor: { blockId: B1, blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    status: 'new',
    interventionKind: 'testimony',
  }),
  // The landed change: a tick, and the revision object on click.
  comment({
    id: 'cmt_demo_002',
    chapter: 1,
    anchor: {
      blockId: B2,
      blockIndex: 1,
      quote: 'Свет был включён до меня.',
      prefix: 'Я вошёл в пустую комнату. ',
      suffix: null,
      resolved: true,
    },
    author: 'Борис',
    body: 'свет включили до него — это важно для сцены',
    status: 'applied',
    interventionKind: 'document',
    changeId: 'chg_demo',
    applied: { chapter: 1, rev: 4 },
    createdAt: '2026-10-24T09:10:00Z',
  }),
  // In work (underlined, live ink) and held (struck, stopped ink): the two other shapes.
  comment({
    id: 'cmt_demo_003',
    chapter: 2,
    anchor: { blockId: B4, blockIndex: 0, quote: 'В коридоре было тихо.', prefix: null, suffix: null, resolved: true },
    author: 'Вера',
    status: 'accepted',
    interventionKind: 'decision',
    createdAt: '2026-10-25T10:00:00Z',
  }),
  comment({
    id: 'cmt_demo_004',
    chapter: 2,
    anchor: { blockId: B4, blockIndex: 0, quote: 'Кто-то поднимался по лестнице.', prefix: null, suffix: null, resolved: true },
    author: 'Глеб',
    status: 'quarantined',
    interventionKind: 'erasure',
    reason: 'проверяется перед триажем',
    createdAt: '2026-10-25T11:00:00Z',
  }),
];

function header(row: CatalogEntry, printing = false): ReactElement {
  return (
    <header className="ch-h">
      <span className="ch-id">
        <h2 className="ch-n" aria-hidden="true">
          {String(row.n).padStart(2, '0')}
        </h2>
      </span>
      <span className="ch-meta">{printing ? '■ печатается · 12 000 · 09:20' : '12 000 · 09:20'}</span>
    </header>
  );
}

function paragraph(row: CatalogEntry, index: number, blockId: string, text: string): ReactElement {
  return (
    <ProseParagraph
      entry={row}
      blockId={blockId}
      blockIndex={index}
      baseRev={row.rev}
      text={text}
      frozen={false}
      comments={COMMENTS}
      composer={EMPTY_COMPOSER}
      viewer={VIEWER}
      onPosted={() => undefined}
    />
  );
}

/** The empty slot as it was before BOOK-90 A: the real old classes, the old look. */
function BeforeEmpty({ n }: { n: number }): ReactElement {
  const num = String(n).padStart(2, '0');
  return (
    <article className="page ch ch-empty before-ch" id={`ch-${n}`} data-n={n} aria-label={`глава ${n}`}>
      <header className="ch-h">
        <span className="ch-id">
          <h2 className="ch-n">{num}</h2>
        </span>
        <span className="ch-meta">не написана</span>
      </header>
      <div className="premise">
        <button type="button" className="premise-row">
          <span className="premise-n">{num}</span>
          <span className="premise-field" />
          <span className="premise-label">замысел</span>
        </button>
        <p className="premise-hint">{PREMISE_HINT}</p>
      </div>
    </article>
  );
}

function EmptySlot({ n, firstEmpty, viewer = VIEWER }: { n: number; firstEmpty?: boolean; viewer?: ViewerDto }): ReactElement {
  if (before) return <BeforeEmpty n={n} />;
  return (
    <ChapterArticle
      entry={emptyEntry(n)}
      revision={null}
      revising={null}
      caret={null}
      fresh={false}
      firstEmpty={firstEmpty === true}
      history
      composer={EMPTY_COMPOSER}
      viewer={viewer}
      onPosted={() => undefined}
    />
  );
}

function FinalScene(): ReactElement {
  return (
    <>
      <Header
        state={STATE}
        ribbon={null}
        catalog={[CH1, CH2, emptyEntry(3), emptyEntry(4), CH5, entry(22), entry(23), entry(24), entry(25), emptyEntry(21)]}
        markers={[]}
        onOpenChange={() => undefined}
      />
      <div className="canvas">
        <main className="page">
          <article className="page ch" id="ch-1" data-n={1} aria-label="глава 1">
            {header(CH1)}
            <h3 className="ch-title">Комната на восьмом</h3>
            {paragraph(CH1, 0, B1, P1)}
            {paragraph(CH1, 1, B2, P2F)}
          </article>
          <EmptySlot n={3} firstEmpty viewer={SIGNED_IN} />
        </main>
      </div>
      {/* Enough page after the slot, so the phone shot can lift the row clear of the sheet. */}
      <div className="after-space" aria-hidden="true" />
      <MarginTail />
    </>
  );
}

const SIGNED_IN = { signedIn: true, displayName: 'Филипп' } as const;
const STRIP_ENTRY = emptyEntry(3);
const STRIP_SENTENCE = { text: 'Её освещал яркий свет.', start: 26, end: 49 };
const STRIP_ANCHOR: SeamAnchor = {
  blockId: 'ch08#aa11bb22',
  baseRev: 3,
  quote: STRIP_SENTENCE.text,
  prefix: 'Я вошёл в пустую комнату. ',
  suffix: '',
  sentence: STRIP_SENTENCE,
  word: 'свет',
};
const HELD_PREMISE = comment({
  id: 'cmt_demo_010',
  chapter: 3,
  premise: true,
  anchor: { blockId: null, blockIndex: null, quote: 'свет в комнате', prefix: null, suffix: null, resolved: true },
});
const STRIP_FILING = comment({
  id: 'cmt_demo_003',
  chapter: 8,
  author: 'Глеб Романович',
  status: 'accepted',
  interventionKind: 'decision',
  createdAt: '2026-10-25T10:00:00Z',
  anchor: { blockId: STRIP_ANCHOR.blockId, blockIndex: 1, quote: STRIP_ANCHOR.quote, prefix: null, suffix: null, resolved: true },
});
const STRIP_FILINGS = filingsForBlock([STRIP_FILING], STRIP_ANCHOR.blockId)[0]!;
const DRAFT_KEY = 'ch08:strip-demo';
seamDrafts.keep(DRAFT_KEY, {
  ...emptyDraft({ chapter: 8, blockId: STRIP_ANCHOR.blockId, baseRev: 3, blockIndex: 1, sentence: STRIP_ANCHOR.quote }),
  body: 'в комнате должен быть свет, но не от лампы',
});

function Demo({ id, children }: { id: string; children: ReactElement }): ReactElement {
  return (
    <section className="ch-empty" data-strip={id}>
      {children}
    </section>
  );
}

const noop = (): void => undefined;

/** The strip's states, each with the real `Seam` and its own draft key. */
function StripScene(): ReactElement {
  return (
    <div className="canvas">
    <main className="page">
      <Demo id="premise">
        <Seam entry={STRIP_ENTRY} draftKey="ch3:premise-empty" anchor={null} frozen={false} filings={null}
          composer={EMPTY_COMPOSER} viewer={SIGNED_IN} onPosted={noop} onClose={noop}
          onProvenance={noop} onOpenFiling={noop} premiseHint={false} />
      </Demo>
      <Demo id="held">
        <Seam entry={STRIP_ENTRY} draftKey="ch3:premise-held" anchor={null} frozen={false} filings={null}
          existingPremise={HELD_PREMISE} composer={EMPTY_COMPOSER} viewer={SIGNED_IN} onPosted={noop}
          onClose={noop} onProvenance={noop} onOpenFiling={noop} premiseHint={false} />
      </Demo>
      <Demo id="provenance">
        <Seam entry={STRIP_ENTRY} draftKey="ch08:provenance" anchor={STRIP_ANCHOR} frozen={false} filings={null}
          composer={EMPTY_COMPOSER} viewer={SIGNED_IN} onPosted={noop} onClose={noop}
          onProvenance={noop} onOpenFiling={noop} premiseHint={false} />
      </Demo>
      <Demo id="draft">
        <Seam entry={STRIP_ENTRY} draftKey={DRAFT_KEY} anchor={STRIP_ANCHOR} frozen={false} filings={null}
          composer={EMPTY_COMPOSER} viewer={SIGNED_IN} onPosted={noop} onClose={noop}
          onProvenance={noop} onOpenFiling={noop} premiseHint={false} />
      </Demo>
      <Demo id="receipt">
        <Seam entry={STRIP_ENTRY} draftKey="ch3:premise-receipt" anchor={null} frozen={false} filings={null}
          composer={EMPTY_COMPOSER} viewer={SIGNED_IN} onPosted={noop} onClose={noop}
          onProvenance={noop} onOpenFiling={noop} premiseHint={false} />
      </Demo>
      <Demo id="filings">
        <Seam entry={STRIP_ENTRY} draftKey="ch08:filings" anchor={STRIP_ANCHOR} frozen={false} filings={STRIP_FILINGS}
          composer={EMPTY_COMPOSER} viewer={SIGNED_IN} onPosted={noop} onClose={noop}
          onProvenance={noop} onOpenFiling={noop} premiseHint={false} />
      </Demo>
    </main>
    </div>
  );
}

function App(): ReactElement {
  if (strips) return <StripScene />;
  if (final) return <FinalScene />;
  return (
    <>
      <Header
        state={STATE}
        ribbon={null}
        catalog={[CH1, CH2, emptyEntry(3), emptyEntry(4), CH5, entry(22), entry(23), entry(24), entry(25), emptyEntry(21)]}
        markers={[]}
        onOpenChange={() => undefined}
        live
      />
      {/* The cover: before the first chapter the head names no chapter (BOOK-90 B.2). */}
      <div className="cover-space" aria-hidden="true" />
      <main>
        <article className="page ch" id="ch-1" data-n={1} aria-label="глава 1">
          {header(CH1)}
          <h3 className="ch-title">Комната на восьмом</h3>
          {paragraph(CH1, 0, B1, P1)}
          {paragraph(CH1, 1, B2, P2)}
          {paragraph(CH1, 2, B3, P3)}
        </article>
        <article className="page ch" id="ch-2" data-n={2} aria-label="глава 2">
          {header(CH2, true)}
          <h3 className="ch-title">Свет до меня</h3>
          {paragraph(CH2, 0, B4, P4)}
        </article>
        {/* Two empty slots side by side: the hint is on the first one only. */}
        <EmptySlot n={3} firstEmpty />
        <EmptySlot n={4} />
        {/* A written chapter after the empty slots: the opened strip must not cover its text. */}
        <article className="page ch" id="ch-5" data-n={5} aria-label="глава 5">
          {header(CH5)}
          <h3 className="ch-title">Лестница</h3>
          {paragraph(CH5, 0, B5, P5)}
        </article>
        {/* A later empty slot and a written chapter after it, so 21 can sit in the band. */}
        <EmptySlot n={21} />
        <article className="page ch" id="ch-22" data-n={22} aria-label="глава 22">
          {header(entry(22, { title: 'Дверь' }))}
          <h3 className="ch-title">Дверь</h3>
          {paragraph(entry(22, { title: 'Дверь' }), 0, 'ch22#p1', P5)}
        </article>
        {/* Enough page after the slot under test, so chapter 21 can sit under the head. */}
        <article className="page ch" id="ch-23" data-n={23} aria-label="глава 23">
          {header(entry(23, { title: 'Коридор' }))}
          <h3 className="ch-title">Коридор</h3>
          {paragraph(entry(23, { title: 'Коридор' }), 0, 'ch23#p1', P1)}
        </article>
        <article className="page ch" id="ch-24" data-n={24} aria-label="глава 24">
          {header(entry(24, { title: 'Окно' }))}
          <h3 className="ch-title">Окно</h3>
          {paragraph(entry(24, { title: 'Окно' }), 0, 'ch24#p1', P2)}
        </article>
        <article className="page ch" id="ch-25" data-n={25} aria-label="глава 25">
          {header(entry(25, { title: 'Утро' }))}
          <h3 className="ch-title">Утро</h3>
          {paragraph(entry(25, { title: 'Утро' }), 0, 'ch25#p1', P3)}
        </article>
      </main>
      <MarginTail />
    </>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from marginalia.html');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
