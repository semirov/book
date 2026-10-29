import type { ChangeDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { track } from '../lib/analytics.ts';
import { changeNumber } from '../lib/changeStatus.ts';
import { changeView } from '../lib/changeView.ts';

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
      {view.steps.length === 0 ? null : (
        <ol className="rec-change-steps">
          {view.steps.map((step) => (
            <li className="rec-change-step" key={step.key}>
              {step.text}
            </li>
          ))}
        </ol>
      )}
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
