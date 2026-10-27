import { interventionKindLabel, type ChangeDto, type ChangeStepDto } from '@book/shared';
import { useEffect, useRef } from 'react';

import { track } from '../lib/analytics.ts';
import {
  boundaryLabel,
  changeHeading,
  chapterRange,
  outcomeCopy,
  premiseOutcomeCopy,
  relevanceCopy,
  stampCopy,
  stepLabel,
  wingGlyph,
} from '../lib/changeStatus.ts';
import { WING_WORDS, wingOfChapter } from '../lib/cascade.ts';
import { changeDeedLine } from '../lib/deed.ts';
import { costLine, focusHash } from '../lib/focus.ts';
import { formatCharsShort, formatTime } from '../lib/format.ts';

/**
 * The change card (ARCHITECTURE §11.7, DESIGN §7.11–7.13): the intent as the author's
 * quoted words, the case it became, how far the consequence travelled in **both** wings,
 * which seams it reported, and the outcome.
 *
 * The outcome is делопроизводство, not «готово»: the card prints the states that really
 * happened (`lib/deed.ts`) — registered, filed, amended, cause established, divergence
 * recorded — and a cause carries its mode («оформление», «поправка: пункт изложен в новой
 * редакции»). Every chapter of a wing is a link to that chapter, and says which wing reached
 * it and why. There is no gate section and no field to build one from: the DTO has no
 * verdict, no finding text and no role (§6B.6).
 */
export function ChangeCard({
  change,
  onClose,
  onOpenChapter,
}: {
  change: ChangeDto;
  onClose: () => void;
  /** Reaching a chapter of either wing leaves the card and opens that chapter. */
  onOpenChapter?: (chapter: number) => void;
}) {
  // BOOK-63: the change's record was opened — once per change, not once per render.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === change.id) return;
    announced.current = change.id;
    track('record_open', {});
  }, [change.id]);

  // BOOK-16: the kind, as the plain word a reader already knows from the rules page.
  const kindWord = interventionKindLabel(change.interventionKind);
  // BOOK-23: model and tokens always; the rubles only when they were measured.
  const cost = costLine(change, null);
  const wings = change.steps.filter((step) => typeof step.chapter === 'number' && step.wing !== null);
  const reached = [...new Set(wings.map((step) => step.chapter as number))].sort((left, right) => left - right);

  return (
    // BOOK-77 (audit F1): the intent is the reader's own sentence and `source.author` a reader's
    // name — Webvisor records neither.
    <section className="change-card ym-hide-content" role="dialog" aria-modal="false" aria-label={changeHeading(change)}>
      <header className="change-card-h">
        <span className="change-card-n">{changeHeading(change)}</span>
        <span className={`stamp stamp-${change.status}`}>{stampCopy(change)}</span>
        <button className="change-card-x" type="button" onClick={onClose} aria-label="закрыть карточку правки">
          ×
        </button>
      </header>

      <blockquote className="intent">
        «{change.intent}»
        <footer>
          формулировка автора
          {change.source.author === null ? '' : ` · из замечания ${change.source.author}`}
          {kindWord === null ? '' : ` · вносит ${kindWord}`}
        </footer>
      </blockquote>

      <p className="change-deed">{changeDeedLine(change)}</p>

      <dl className="change-facts">
        <div>
          <dt>основа</dt>
          <dd>
            {change.premise
              ? 'главы ещё нет — замысел'
              : change.relevance === null
                ? `записана на ревизии ${change.base.rev}`
                : relevanceCopy(change.relevance.grade)}
          </dd>
        </div>
        <div>
          <dt>затронуто</dt>
          <dd>{reached.length === 0 ? `глава ${change.chapter}` : `главы ${chapterRange(reached)}`}</dd>
        </div>
        <div>
          <dt>сейчас</dt>
          <dd>
            {change.position === null ? stampCopy(change) : `${change.position}-я в очереди`}
          </dd>
        </div>
      </dl>

      {change.relevance !== null && change.relevance.evidence.length > 0 ? (
        <ul className="change-evidence">
          {change.relevance.evidence.slice(0, 3).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <div className="change-steps">
        <span className="change-sub">шаги правки</span>
        {change.steps.length === 0 ? (
          <p className="change-empty">шагов пока нет</p>
        ) : (
          <ol>
            {change.steps.map((step) => (
              <li key={`${step.seq}-${step.at}`} className={step.outcome === null ? 'is-live' : ''}>
                <span className="step-glyph" aria-hidden="true">
                  {wingGlyph(step)}
                </span>
                <span className="step-label">{stepLabel(step)}</span>
                <span className="step-wing">{stepWingCopy(step, change.chapter)}</span>
                <span className="step-delta">
                  {step.charsDelta === null ? '' : `${step.charsDelta > 0 ? '+' : ''}${formatCharsShort(step.charsDelta)}`}
                </span>
                {typeof step.chapter === 'number' && onOpenChapter !== undefined ? (
                  <button type="button" className="step-open" onClick={() => onOpenChapter(step.chapter as number)}>
                    к главе
                  </button>
                ) : null}
                {stepWhy(step) === null ? null : <span className="step-why">{stepWhy(step)}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>

      {change.cascade !== null && change.cascade.seams.length > 0 ? (
        <div className="change-seams">
          <span className="change-sub">стыки</span>
          <ul>
            {change.cascade.seams.map((seam) => (
              <li key={String(seam.boundary)} className={seam.resolved ? '' : 'is-open'}>
                <span className="seam-boundary">{boundaryLabel(seam.boundary)}</span>
                <span className="seam-reason">{seam.reason}</span>
                {seam.resolved ? null : <span className="seam-state">стык пересматривается</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="change-foot">
        <span className="change-outcome">
          {change.premise ? premiseOutcomeCopy(change) : outcomeCopy(change.outcome)}
        </span>
        {change.reason !== null ? <span className="change-reason">{change.reason}</span> : null}
        {cost === null ? null : <span className="change-cost">{cost}</span>}
        {change.decidedAt === null ? null : <span className="change-time">закрыта {formatTime(change.decidedAt)}</span>}
        <a className="change-focus" href={focusHash(change.id)}>
          прицел →
        </a>
      </footer>
    </section>
  );
}

/**
 * «вниз» / «вверх» / «здесь» — which wing reached this chapter, from the change's origin.
 * The first sheet and the finale are not wings: a ripple evaluates chapter 67, it never walks
 * the up wing into it, so the ending step is named «финал» and the front step «обложка».
 */
function stepWingCopy(step: ChangeStepDto, origin: number): string {
  if (step.pass === 'front') return 'обложка';
  if (step.pass === 'ending') return 'финал';
  if (typeof step.chapter !== 'number') return 'здесь';
  const wing = step.wing === 'downward' ? 'down' : step.wing === 'upward' ? 'up' : wingOfChapter(step.chapter, origin);
  if (wing === 'origin') return 'здесь';
  return WING_WORDS[wing];
}

/** Why the consequence reached this chapter: the inbound seam's clause, never a verdict. */
function stepWhy(step: ChangeStepDto): string | null {
  if (step.note !== null && step.note.length > 0) return step.note;
  const seam = step.seamsIn[0];
  return seam === undefined ? null : seam.reason;
}
