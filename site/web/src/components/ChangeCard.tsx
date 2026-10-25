import type { ChangeDto } from '@book/shared';

import {
  boundaryLabel,
  changeHeading,
  chapterRange,
  outcomeCopy,
  relevanceCopy,
  stampCopy,
  stepLabel,
  wingGlyph,
} from '../lib/changeStatus.ts';
import { focusHash } from '../lib/focus.ts';
import { formatCharsShort, formatTime } from '../lib/format.ts';

/**
 * The change card (ARCHITECTURE §11.7, DESIGN §7.11–7.13): the intent as the author's
 * quoted words, how far the consequence travelled, which seams it reported, and the
 * outcome. One REST call, no streaming.
 *
 * There is no gate section and no field to build one from: the DTO has no verdict, no
 * finding and no role (§6B.6). The only trace of the hidden pass is the honest aggregate
 * «замечание сохранено», which is already part of a step's public label.
 */
export function ChangeCard({ change, onClose }: { change: ChangeDto; onClose: () => void }) {
  const wings = change.steps.filter((step) => typeof step.chapter === 'number' && step.wing !== null);
  const reached = [...new Set(wings.map((step) => step.chapter as number))].sort((left, right) => left - right);

  return (
    <section className="change-card" role="dialog" aria-modal="false" aria-label={changeHeading(change)}>
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
        </footer>
      </blockquote>

      <dl className="change-facts">
        <div>
          <dt>основа</dt>
          <dd>
            {change.relevance === null ? `записана на ревизии ${change.base.rev}` : relevanceCopy(change.relevance.grade)}
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
                <span className="step-delta">
                  {step.charsDelta === null ? '' : `${step.charsDelta > 0 ? '+' : ''}${formatCharsShort(step.charsDelta)}`}
                </span>
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
        <span className="change-outcome">{outcomeCopy(change.outcome)}</span>
        {change.reason !== null ? <span className="change-reason">{change.reason}</span> : null}
        {change.cost === null ? null : (
          <span className="change-cost">
            {formatCharsShort(change.cost.tokensIn + change.cost.tokensOut)} токенов · {change.cost.rub.toFixed(2)} ₽
          </span>
        )}
        {change.decidedAt === null ? null : <span className="change-time">закрыта {formatTime(change.decidedAt)}</span>}
        <a className="change-focus" href={focusHash(change.id)}>
          прицел →
        </a>
      </footer>
    </section>
  );
}
