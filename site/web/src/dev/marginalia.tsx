import type { CatalogEntry, CommentDto, StateSnapshot } from '@book/shared';
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ChapterArticle } from '../components/ChapterArticle.tsx';
import { Header } from '../components/Header.tsx';
import { MarginTail } from '../components/MarginTail.tsx';
import { ProseParagraph } from '../components/ProseParagraph.tsx';
import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { PREMISE_HINT } from '../lib/premise.ts';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/chrome.css';
import '../styles/running-head.css';
import '../styles/consent.css';
import '../styles/book.css';
import '../styles/live.css';
import '../styles/cascade.css';
import '../styles/ribbon.css';
import '../styles/chronicle.css';
import '../styles/focus.css';
import '../styles/seam.css';
import '../styles/panels.css';
import '../styles/seam-form.css';
import '../styles/marginalia.css';
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
const before = new URLSearchParams(window.location.search).has('before');

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
    anchor: { blockId: B2, blockIndex: 1, quote: 'Свет был включён до меня.', prefix: null, suffix: null, resolved: true },
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

function EmptySlot({ n, firstEmpty }: { n: number; firstEmpty?: boolean }): ReactElement {
  if (before) return <BeforeEmpty n={n} />;
  return (
    <ChapterArticle
      entry={emptyEntry(n)}
      revision={null}
      revising={null}
      caret={null}
      fresh={false}
      firstEmpty={firstEmpty === true}
      composer={EMPTY_COMPOSER}
      viewer={VIEWER}
      onPosted={() => undefined}
    />
  );
}

function App(): ReactElement {
  return (
    <>
      <Header state={STATE} ribbon={null} markers={[]} onOpenChange={() => undefined} />
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
