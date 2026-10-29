import type { CatalogEntry, CommentDto } from '@book/shared';
import { createRoot } from 'react-dom/client';

import { EMPTY_COMPOSER } from '../src/lib/composer.ts';
import { resetParagraphChainCache } from '../src/lib/paragraphChainCache.ts';
import { MarginTail } from '../src/components/MarginTail.tsx';
import { ProseParagraph } from '../src/components/ProseParagraph.tsx';
import { SentenceBlock } from '../src/components/SentenceBlock.tsx';

import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/book.css';
import '../src/styles/live.css';
import '../src/styles/seam.css';
import '../src/styles/seam-form.css';
import '../src/styles/panels.css';
import '../src/styles/marginalia.css';
import '../src/styles/reader.css';
import '../src/styles/record.css';
import '../src/styles/record-notice.css';
import '../src/styles/foot-jumps.css';

/**
 * BOOK-208 — the CDP harness entry: the margin's objects, in the page's own geometry.
 *
 * The defect this page exists for is horizontal, and jsdom has no layout to see it: a note
 * whose `left`/`width` lost their tokens was laid shrink-to-fit **inside** the prose. So the
 * page mounts the real reader — two `ProseParagraph`s with one filing each (a `.margin-note`
 * and an alive `.filing-mark` apiece, so the ledger has a second note to stack) and an open
 * `SentenceBlock` — and the real sheets, then waits for the margin pass to have placed
 * everything and says so on `<body>`.
 *
 * `scripts/margin-cdp.mjs` reads the boxes; nothing is measured here.
 */

/** One sentence, so the filing's clamped quote is the sentence it marks — no anchor guessing. */
const TEXT = 'Свет был включён до меня, и никто не говорил об этом.';
/** A second filing, on its own line: the pass is a ledger, and one note proves no stacking. */
const SECOND = 'Дверь осталась приоткрытой, и свет из коридора лежал на полу.';
/** And paragraphs after them: a margin object must never push the prose it belongs to. */
const AFTER = [
  'Потом я закрыл дверь и долго стоял в темноте, слушая, как часы идут по кругу.',
  'Часы шли по кругу, и никто не спрашивал, который час.',
  'На столе лежал лист бумаги, и на нём не было ни строки.',
];

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Комната',
  rev: 1,
  chars: TEXT.length,
  blocks: 4,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

/** The filing on the first paragraph: new, so the mark is alive and the note is drawn. */
const FILING: CommentDto = {
  id: 'cmt_harness_margin_A7K',
  // BOOK-218 — the filing's own public number, a column of the record.
  number: 7,
  chapter: 1,
  anchor: { blockId: 'ch01#harness', blockIndex: 0, quote: TEXT, prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'в комнате должен быть свет, но не от лампы',
  proposedText: null,
  interventionKind: null,
  status: 'new',
  refusal: null,
  attempt: null,
  frame: null,
  premise: false,
  reason: null,
  createdAt: '2026-10-27T12:00:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
};

/** The second paragraph's filing: same state, its own sentence, so two notes stand at once. */
const SECOND_FILING: CommentDto = {
  ...FILING,
  id: 'cmt_harness_margin_C4T',
  // BOOK-218 — its own public number, not the first filing's: two marks must not print one 7.
  number: 8,
  anchor: { blockId: 'ch01#harness-b', blockIndex: 1, quote: SECOND, prefix: null, suffix: null, resolved: true },
  author: 'Филипп',
  body: 'коридор не должен светиться: дверь ведёт в темноту',
};

// The block's own history is not what this page measures: no chain is the honest fixture.
resetParagraphChainCache();

const mount = document.getElementById('mount');
if (mount === null) throw new Error('#mount is missing');
const objects = document.getElementById('mount-objects');
if (objects === null) throw new Error('#mount-objects is missing');

/**
 * `history={true}`: a written chapter is read with the record live — the word's door and the
 * provenance body are part of the page a note stands beside, and with history off the reader
 * renders a different paragraph.
 */
createRoot(mount).render(
  <>
    <ProseParagraph
      entry={ENTRY}
      blockId="ch01#harness"
      blockIndex={0}
      baseRev={ENTRY.rev}
      text={TEXT}
      blockCount={ENTRY.blocks}
      comments={[FILING]}
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: true, displayName: 'Филипп' }}
      onPosted={() => undefined}
      history={true}
    />
    <ProseParagraph
      entry={ENTRY}
      blockId="ch01#harness-b"
      blockIndex={1}
      baseRev={ENTRY.rev}
      text={SECOND}
      blockCount={ENTRY.blocks}
      comments={[SECOND_FILING]}
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: true, displayName: 'Филипп' }}
      onPosted={() => undefined}
      history={true}
    />
  </>,
);

/**
 * The block a reader opens from a sentence: mounted open, in the margin's place and inside a
 * `.p`, because that is where the page opens it and where the pass looks for it. `MarginTail`
 * is the page's one margin engine, exactly as the reader mounts it.
 */
createRoot(objects).render(
  <>
    <p className="p" id="harness-sentence" data-block-id="ch01#harness-sentence">
      Откуда эта фраза — вопрос, на который отвечает блок в поле.
      <SentenceBlock
        chain={null}
        loading={false}
        failed={false}
        quote="Откуда эта фраза"
        frame="none"
        place="margin"
        onRetry={() => undefined}
        onClose={() => undefined}
      />
    </p>
    {AFTER.map((text, index) => (
      <p className="p" key={text} data-block-id={`ch01#harness-after-${String(index)}`}>
        {text}
      </p>
    ))}
    <MarginTail />
  </>,
);

/**
 * Ready means placed: every paragraph that carries a margin item has had `data-margin` written
 * (that is the pass's own guard, and its absence would mean an unrun pass), at least one
 * object exists, and no note is still waiting for its `data-placed`. The check is polled on
 * frames rather than timed, so a slow font or a late commit cannot be measured early.
 */
function placed(): boolean {
  const items = [...document.querySelectorAll<HTMLElement>('[data-margin-item]')];
  if (items.length === 0) return false;
  const paragraphs = new Set(items.map((item) => item.closest<HTMLElement>('.p')).filter((p): p is HTMLElement => p !== null));
  for (const paragraph of paragraphs) {
    if (paragraph.dataset.margin === undefined) return false;
  }
  const notes = [...document.querySelectorAll<HTMLElement>('.margin-note')];
  if (notes.some((note) => getComputedStyle(note).display !== 'none' && note.dataset.placed !== 'true')) return false;
  // Two filings, so two notes and two marks: one of each would make the ledger unmeasurable.
  return notes.length >= 2 && document.querySelectorAll('.filing-mark').length >= 2;
}

function settle(attempt = 0): void {
  if (placed()) {
    document.body.dataset.harnessReady = 'true';
    return;
  }
  if (attempt > 240) return; // never ready: the script's own timeout reports the failure
  requestAnimationFrame(() => settle(attempt + 1));
}

requestAnimationFrame(() => settle());
