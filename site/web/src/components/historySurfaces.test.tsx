import type { CatalogEntry, CommentDto, ParagraphChainDto, StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { historyLive } from '../lib/historyState.ts';
import { provenanceView } from '../lib/provenance.ts';
import type { Ribbon } from '../lib/cascade.ts';
import { Chronicle } from './Chronicle.tsx';
import { Discussion } from './Discussion.tsx';
import { EndMatter } from './EndMatter.tsx';
import { FocusWings } from './FocusWings.tsx';
import { Opening } from './Opening.tsx';
import { ParagraphChain } from './ParagraphChain.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';
import { ProvenancePanel } from './ProvenancePanel.tsx';

/**
 * BOOK-56 — one fact, every history surface.
 *
 * The two tests below render the **same** live-shaped fixture twice: once with no reader
 * change and once with one. Nothing here inspects a CSS class to decide what is hidden —
 * the absent surfaces are absent from the markup, and the kept ones (the cover, page 2, the
 * seam, a filing's own mark) are still there.
 */

const imprint = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };

const catalog: CatalogEntry[] = Array.from({ length: 67 }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: (n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4) as CatalogEntry['part'],
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: n === 1 || n === 67,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 34 ? 'forward' : 'backward',
  };
});

function state(live: boolean): StateSnapshot {
  return {
    version: 1,
    at: '2026-10-25T12:00:00Z',
    engine: { status: 'unknown', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: 'Бланк', about: 'О чём эта книга.', rev: 1, updatedAt: null },
    chapters: { total: 67, written: [], empty: catalog.map((row) => row.n), count: 0, totalChars: 0, basis: [1, 67] },
    cursors: {} as StateSnapshot['cursors'],
    toc: catalog.map((row) => ({ part: row.part, n: row.n, title: null, written: false, rev: 0 })),
    meeting: { forwardFront: null, backwardFront: null, gap: 67, converged: false, seam: 'not_reached' },
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
    history: { live, readerChanges: live ? 1 : 0 },
  };
}

const ribbon: Ribbon = {
  changeId: 'chg_7',
  cascadeId: 'csc_7',
  chapter: 8,
  wave: 2,
  status: 'open',
  outcome: null,
  touched: [7, 8, 9],
  rewritten: [9],
  wings: {
    down: { frontier: 7, wave: 2, state: 'moving', reached: [7] },
    up: { frontier: 9, wave: 2, state: 'moving', reached: [9] },
  },
  step: 9,
  frontier: { down: 7, up: 9 },
  seams: [],
};

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  line: 'переписано в 14:20 правкой 7 (Марк) · было: правка 3 (Аня)',
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 1,
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
      actor: { kind: 'reader', identityId: 'idt_2', label: 'Марк' },
      replacedBy: null,
    },
  ],
};

const filing: CommentDto = {
  id: 'cmt_01J9Z8K4Q7',
  chapter: 8,
  anchor: { blockId: 'ch08#aa11bb22', blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'в комнате должен быть свет, но не от лампы',
  proposedText: null,
  interventionKind: null,
  premise: false,
  status: 'new',
  reason: null,
  createdAt: '2026-10-21T12:03:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
};

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

const noop = (): void => undefined;

/** The same page in both states; only the fixture's one fact differs. */
function page(current: StateSnapshot): string {
  const live = historyLive(current);
  return renderToStaticMarkup(
    <>
      <Opening
        front={{
          title: 'Бланк',
          about: 'О чём эта книга.',
          rev: 1,
          toc: current.toc,
          imprint,
          authors: { count: 0, measuredAt: '2026-10-25T12:00:00Z' },
        }}
        state={current}
        ribbon={ribbon}
        catalog={catalog}
        escalation={[]}
        onOpenChange={noop}
        view="book"
        onViewChange={noop}
        live={live}
      />
      <Chronicle catalog={catalog} frontRev={1} tick={0} changes={[]} onOpenChange={noop} live={live} />
      <ProvenancePanel
        view={provenanceView({ word: 'пустую', chapter: 8, variant: 'machine', share: { kind: 'none' }, chain: CHAIN, at: null, history: 'ready', live })}
        anchor={null}
        onClose={noop}
        onForm={noop}
      />
      <FocusWings wings={ribbon.wings} live={live} />
      <ParagraphChain chain={CHAIN} loading={false} failed={false} onClose={noop} onRetry={noop} live={live} />
      <ProseParagraph
        entry={{ ...catalog[7]!, written: true, blocks: 1 }}
        blockId="ch08#aa11bb22"
        blockIndex={0}
        baseRev={1}
        text={TEXT}
        frozen={false}
        comments={[filing]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        onPosted={noop}
        onBlockProvenance={noop}
        history={live}
      />
      <EndMatter imprint={imprint} lastRevisionAt="2026-10-25T09:20:00Z" signedIn={false} onOpenChronicle={noop} live={live} />
      <Discussion depth={0} changes={[]} comments={[]} live={live} />
    </>,
  );
}

describe('with no reader change the history surfaces are not in the markup (AC1, AC6)', () => {
  const html = page(state(false));

  it('renders none of the chronicle, cascade, provenance, apparatus, authors or discussion', () => {
    for (const gone of [
      'class="chronicle',
      'хроника книги',
      'class="chron',
      'class="ribbon',
      'волна',
      'class="prov-rows"',
      'class="prov"',
      '<dt>след</dt>',
      'переписан',
      'class="chain',
      'class="page authors"',
      'Авторы',
      'как менялись доли',
      'class="page talks"',
      'обсуждение',
      'class="views',
      'focus-wings',
    ]) {
      expect(html, `with 0 reader changes the page must not render «${gone}»`).not.toContain(gone);
    }
  });

  it('keeps the cover, page 2, the byline, the seam door and the filing’s own mark', () => {
    expect(html).toContain('class="page titul"');
    expect(html).toContain('class="page annotation"');
    // The byline stays; «+ 0» is a count of nothing and is gone (BOOK-70).
    expect(html).toContain('Филипп Семиров');
    expect(html).not.toContain('+ 0');
    expect(html).toContain('class="seam-rail"');
    // A filing's mark is the current state, not the log: it stays when history is off.
    expect(html).toContain('class="filing-mark');
    // The provenance record keeps its word, its place and the way in — only what the log
    // answers (the DNA rows and the chain) goes.
    expect(html).toContain('откуда это слово');
    expect(html).not.toContain('class="prov-chain"');
    expect(html).toContain('вмешаться здесь');
  });
});

describe('the first reader change turns every surface on (AC3)', () => {
  const html = page(state(true));

  it('renders the chronicle, the cascade, the provenance rows and the revision apparatus', () => {
    expect(html).toContain('class="chronicle');
    expect(html).toContain('class="ribbon');
    expect(html).toContain('волна 2');
    expect(html).toContain('class="focus-wings"');
    expect(html).toContain('class="prov-rows"');
    expect(html).toContain('<dt>след</dt>');
    expect(html).toContain('переписан 1 раз после неё');
    expect(html).toContain('class="prov"');
    expect(html).toContain('class="chain');
  });

  it('renders the authors list, the end-matter link and the discussion', () => {
    // BOOK-77 (HEAD side) appends `ym-hide-content`, so the class string is only a prefix.
    expect(html).toContain('class="page authors');
    expect(html).toContain('Авторы');
    expect(html).toContain('как менялись доли');
    expect(html).toContain('class="page talks');
    expect(html).toContain('class="views');
  });
});
