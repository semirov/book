import { createRoot } from 'react-dom/client';
import { useEffect, type ReactNode } from 'react';

import { Authors } from '../src/components/Authors.tsx';
import { ChangeSection } from '../src/components/ChangeSection.tsx';
import { ChapterHeader } from '../src/components/ChapterHeader.tsx';
import { Colophon } from '../src/components/Colophon.tsx';
import { Discussion } from '../src/components/Discussion.tsx';
import { FilingCard } from '../src/components/FilingCard.tsx';
import { Header } from '../src/components/Header.tsx';
import { LegalPage } from '../src/components/LegalPage.tsx';
import { MarginNote } from '../src/components/MarginNote.tsx';
import { MomentControl } from '../src/components/MomentControl.tsx';
import { NoticeTicket } from '../src/components/Notice.tsx';
import { Offline } from '../src/components/Offline.tsx';
import { OwnDecisions } from '../src/components/OwnDecisions.tsx';
import { PassStrip } from '../src/components/PassStrip.tsx';
import { PhoneStrip } from '../src/components/PhoneStrip.tsx';
import { PremiseRow } from '../src/components/PremiseRow.tsx';
import { FilingBody, RowsList } from '../src/components/RecordParts.tsx';
import { RecordRow } from '../src/components/RecordRow.tsx';
import { TableOfContents } from '../src/components/TableOfContents.tsx';
import { TitleSheet } from '../src/components/TitleSheet.tsx';

import {
  AUTHORS,
  ATTEMPT,
  CATALOG,
  CHANGE,
  COMMENT,
  COMMENT_TWO,
  COMMENTS,
  DECISIONS,
  ENTRY,
  FIXED_NOW,
  FRONT,
  IMPRINT,
  PASS_EVENTS,
  PASS_RECORD,
  PREMISE,
  READER_RECORD,
  RECORDS,
  REC_WINDOW,
  STATE,
} from './lines.fixtures.ts';
import {
  ChFailRow,
  ChrTitle,
  HeadRow,
  PastChapterSummary,
  PastTocRow,
  RecordHead,
  SeamFilingRow,
  SeamProvLine,
  SeamStripRow,
} from './lines.static.tsx';

import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/running-head.css';
import '../src/styles/head-status.css';
import '../src/styles/legal.css';
import '../src/styles/consent.css';
import '../src/styles/book.css';
import '../src/styles/skeleton.css';
import '../src/styles/live.css';
import '../src/styles/capacity.css';
import '../src/styles/cascade.css';
import '../src/styles/ribbon.css';
import '../src/styles/chronicle.css';
import '../src/styles/seam.css';
import '../src/styles/pass-live.css';
import '../src/styles/pass-strip.css';
import '../src/styles/panels.css';
import '../src/styles/seam-form.css';
import '../src/styles/marginalia.css';
import '../src/styles/reader.css';
import '../src/styles/record.css';
import '../src/styles/record-change.css';
import '../src/styles/foot-jumps.css';
import '../src/styles/first-load.css';

/**
 * BOOK-128 comment #3900 §2 — the one-line gallery.
 *
 * One section per audited line, `data-line` naming the selector the audit pinned, so the
 * report's paths read back to that table. `scripts/line-fonts-cdp.mjs` walks the rendered
 * page and reports every line that carries more than one typeface or one size; this page
 * decides nothing, and the report names no expected number.
 *
 * **Deterministic by construction**: no network (the one stub below answers 404), no timer,
 * no random, one fixed clock (`FIXED_NOW`), and every animation-bearing surface is rendered in
 * its settled state. `document.fonts.ready` is the only wait the script performs.
 *
 * Which surfaces are mounted and which are copied markup is stated in `lines.static.tsx` and
 * in the report: a component that needs the paragraph store or a history read is drawn on its
 * own classes instead of being faked with a store it would have to invent.
 */

const noop = (): void => undefined;

/** The one network seam: the harness never talks to a server, and a failed read prints nothing. */
globalThis.fetch = async () => new Response('{"error":"harness"}', { status: 404, headers: { 'content-type': 'application/json' } });

function Line({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section className="harness-line" data-line={id}>
      {/* Harness chrome, not product text: `data-harness` keeps it out of the walk. */}
      <p className="harness-h" data-harness="">
        {id}
      </p>
      {children}
    </section>
  );
}

/** Marks the page settled for the script: every child's effect has already run. */
function Ready() {
  useEffect(() => {
    document.body.dataset.linesReady = 'true';
  }, []);
  return null;
}

function Gallery() {
  return (
    <div className="canvas harness-canvas">
      <Line id=".top-in / .top-row">
        <Header state={STATE} ribbon={null} catalog={CATALOG} markers={[]} onOpenChange={noop} live={false} />
      </Line>
      <Line id=".top-row (all four registers)">
        <HeadRow />
      </Line>
      <Line id=".state-line">
        <Offline />
      </Line>
      <Line id=".ch-fail">
        <ChFailRow />
      </Line>
      <Line id=".author (title sheet)">
        <TitleSheet front={FRONT} />
      </Line>
      <Line id=".toc-link">
        <TableOfContents catalog={CATALOG} state={STATE} currentChapter={null} />
      </Line>
      <Line id=".ch-h / .ch-print">
        <article className="page ch" data-n={1}>
          {/* The header's two lines as one section: the apparatus line (`■ печатается`, the
              data) and the wait sentence on its own block line (BOOK-199 m5). */}
          <ChapterHeader entry={ENTRY} printing status="читаем главу 01" basisSentence={null} />
        </article>
      </Line>
      <Line id=".seam-row">
        <SeamStripRow />
      </Line>
      <Line id=".seam-prov-line">
        <SeamProvLine />
      </Line>
      <Line id=".seam-filing-line">
        <SeamFilingRow comment={COMMENT} />
      </Line>
      <Line id=".rec-head">
        <RecordHead />
      </Line>
      <Line id=".rec-row">
        <RowsList rows={REC_WINDOW} lifted={false} onLift={noop} onFold={noop} />
      </Line>
      <Line id=".comment-meta / .sec-h / .comment-attempt / .qline">
        <Discussion depth={0} comments={COMMENTS} changes={[ATTEMPT]} live nowMs={FIXED_NOW} />
      </Line>
      <Line id=".filing-head">
        <FilingCard comment={COMMENT} onClose={noop} earlierAttempts={[]} />
      </Line>
      <Line id=".margin-note-head">
        <MarginNote comment={COMMENT_TWO} onOpen={noop} />
      </Line>
      <Line id=".phone-strip-row">
        <PhoneStrip comments={COMMENTS} skipQuote={null} onOpen={noop} />
      </Line>
      <Line id=".rec-filing-facts / .rec-filing-text">
        <div className="rec">
          <FilingBody comment={COMMENT_TWO} onBack={noop} before="была одна лампа" after="лампа погасла" />
        </div>
      </Line>
      <Line id=".chr-title">
        <ChrTitle />
      </Line>
      <Line id=".chr-row">
        <ol className="chronicle-list">
          <RecordRow record={READER_RECORD} />
          <RecordRow record={PASS_RECORD} />
        </ol>
      </Line>
      <Line id=".scrub-head">
        <MomentControl items={RECORDS} lastHseq={12} lastAt={READER_RECORD.at} more={false} thumb={null} onInput={noop} onCommit={noop} />
      </Line>
      <Line id=".past-toc-row">
        <PastTocRow />
      </Line>
      <Line id=".past-ch summary">
        <PastChapterSummary />
      </Line>
      <Line id=".pass-strip-head / .pass-strip-heading">
        <PassStrip chapter={1} events={PASS_EVENTS} onClose={noop} />
      </Line>
      <Line id=".rec-change-row / .rec-change-facts / .rec-change-step">
        <ChangeSection change={CHANGE} before="была одна лампа" after="лампа погасла" />
      </Line>
      <Line id=".premise-row / .premise-meta">
        <PremiseRow row={PREMISE} onOpen={noop} onRevise={noop} />
      </Line>
      <Line id=".authors-row">
        <Authors authors={AUTHORS} imprint={IMPRINT} lastRevisionAt="2026-10-27T09:20:00Z" live decisions={DECISIONS} />
      </Line>
      <Line id=".own-decision-meta">
        <OwnDecisions decisions={DECISIONS} />
      </Line>
      <Line id=".colophon .row">
        <Colophon state={STATE} imprint={IMPRINT} />
      </Line>
      <Line id=".consent-actions / .consent-state">
        <LegalPage page="privacy" />
      </Line>
      <Line id=".legal p code">
        <LegalPage page="privacy" />
      </Line>
      <Line id=".ticket">
        <NoticeTicket notice={{ kind: 'new', n: 8 }} onGo={noop} onDismiss={noop} />
      </Line>
      <Ready />
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing');
createRoot(container).render(<Gallery />);

declare global {
  interface Window {
    __lines?: { ready: () => boolean; sections: () => string[] };
  }
}

window.__lines = {
  ready: () => document.body.dataset.linesReady === 'true',
  sections: () => [...document.querySelectorAll('[data-line]')].map((node) => node.getAttribute('data-line') ?? ''),
};
