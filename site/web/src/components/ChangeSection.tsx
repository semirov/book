import type { ChangeDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { track } from '../lib/analytics.ts';
import { changeNumber } from '../lib/changeStatus.ts';
import { changeView } from '../lib/changeView.ts';
import { STAGE_WORDS, changeLineOf, closedPassOf, liveLineOf, passLineOf, useLiveChange } from '../lib/liveChange.ts';
import { usePassStages } from '../lib/passStages.ts';

import { FollowWord } from './FollowWord.tsx';
import { SectionHeader } from './RecordParts.tsx';

/**
 * The record's `правка` section: a change in the record's register, never a surface of its own.
 *
 * The numeral (`014`) is the section header's value, printed by `Record` beside the word
 * «правка»; the body is stacked rows — the touched sentence before and after, the state word
 * with its moment, the change's outcome, and one line per step. A label sits above its value
 * (one line, one face), and nothing here is fixed, floating or scrollable: the page is the
 * scroller and the record only grows.
 *
 * With no sentence (a premise, an author's own change) the rows that would quote one are
 * absent; the change's own words stand in their place, and the chapter's row carries it.
 *
 * BOOK-220 B2/M3 — the section is also where the change's live facts land: the last change frame
 * (`queued`/`processing`/`adapted`/`stale`) prints its own line in place, a closed pass prints
 * its own sentence and price, and the stages of that one pass are read back from the store — a
 * reader who was not connected when it ran still reads what it did.
 */
export function ChangeSection({
  change,
  before,
  after,
}: {
  change: ChangeDto;
  /** The filing's anchor quote — the sentence as the change found it. */
  before: string | null;
  /** The record's own quote — the sentence as it stands. */
  after: string | null;
}) {
  const view = changeView(change, before, after);
  /** BOOK-63: the change's record was opened — once per change, not once per render. */
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === change.id) return;
    announced.current = change.id;
    track('record_open', {});
  }, [change.id]);
  const facts = useLiveChange();
  const line = changeLineOf(facts, change.id);
  const live = line === null ? null : liveLineOf(line);
  const pass = closedPassOf(facts, change.id);
  const passLine = pass === null ? null : passLineOf(pass);
  const chapter = pass === null || typeof pass.chapter !== 'number' ? null : pass.chapter;
  const stages = usePassStages(chapter, pass === null ? null : pass.stepId);
  return (
    <div className="rec-change ym-hide-content" data-change={view.id}>
      {view.before === null ? null : (
        <p className="rec-change-row">
          <span className="rec-change-label">было</span>
          <span className="rec-change-quote">«{view.before}»</span>
        </p>
      )}
      {view.after === null ? null : (
        <p className="rec-change-row">
          <span className="rec-change-label">стало</span>
          <span className="rec-change-quote">«{view.after}»</span>
        </p>
      )}
      {view.before === null && view.after === null ? (
        <p className="rec-change-intent">«{view.intent}»</p>
      ) : null}
      <p className="rec-change-facts">{`${view.state} · ${view.stamp}`}</p>
      <p className="rec-change-facts">{view.verdict}</p>
      {/* B2 — the frame's own line, where the change lives: the queue place, the narrowed
          intent, the moved basis. It stands on the record until the change's verdict answers. */}
      {live === null ? null : (
        <p className="rec-change-live" data-line={line?.kind}>
          {live}
        </p>
      )}
      {passLine === null ? null : <p className="rec-change-pass">{passLine}</p>}
      {stages.failed ? (
        <p className="rec-line rec-quiet">ход правки не прочитался</p>
      ) : stages.stages.length === 0 ? null : (
        <ol className="rec-change-stages" aria-label="ход правки">
          {stages.stages.map((event) => (
            <li className="rec-change-stage" key={`${event.passId}:${String(event.stageSeq)}`} data-stage={event.stage}>
              {STAGE_WORDS[event.stage]}
            </li>
          ))}
        </ol>
      )}
      {view.steps.length === 0 ? null : (
        <ol className="rec-change-steps">
          {view.steps.map((step) => (
            <li className="rec-change-step" key={step.key}>
              {step.text}
            </li>
          ))}
        </ol>
      )}
      {/* BOOK-207 — the section's last line: the reader reads what the change is, then decides
          to wait for it. No direction on the record, no control. */}
      <FollowWord changeId={change.id} wings={change.cascade?.wings ?? null} />
    </div>
  );
}

/**
 * The record's `правка` section as one disclosure: the header (label + numeral) and the body
 * of the open section. Kept beside the section itself so the record's own file stays a record.
 */
export function RecordChangeSection({
  open,
  read,
  before,
  after,
  onPress,
}: {
  open: boolean;
  read: { change: ChangeDto | null; failed: boolean };
  before: string | null;
  after: string | null;
  onPress: (control: HTMLElement) => void;
}) {
  return (
    <>
      <SectionHeader
        label="правка"
        count={read.change === null ? null : changeNumber(read.change.seq)}
        open={open}
        onPress={onPress}
      />
      {open ? (
        read.failed ? (
          <p className="rec-line rec-quiet">правка не прочиталась</p>
        ) : read.change === null ? (
          <p className="rec-line rec-quiet">правка читается</p>
        ) : (
          <ChangeSection change={read.change} before={before} after={after} />
        )
      ) : null}
    </>
  );
}
