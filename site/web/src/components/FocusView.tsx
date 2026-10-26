import type {
  BlockDto,
  ChangeDto,
  ChangeImpactDto,
  ChapterRevisionPayload,
  HistoryDiffOpDto,
} from '@book/shared';
import { chapterLabel } from '@book/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getHistoryChapter, getHistoryDiff } from '../api.ts';
import { FocusShell } from './FocusShell.tsx';
import { inertBackground, reducedMotion, scrollToChapter } from '../dom.ts';
import { ribbonMaxWave, type Ribbon } from '../lib/cascade.ts';
import { relevanceCopy, stepLabel, wingGlyph } from '../lib/changeStatus.ts';
import { formatTime } from '../lib/format.ts';
import {
  assessmentCopy,
  basisCopy,
  blocksFromPatch,
  canPrint,
  changedBlocksFromDiff,
  costLine,
  exitTarget,
  focusScale,
  focusStage,
  focusWings,
  footnoteCopy,
  iterationCopy,
  panelStamp,
  scalePercent,
  scaleTicks,
  sheetChapter,
  sheetNotice,
  sheetCopy,
  stageCopy,
  touchedChaptersCopy,
  waveOf,
  wingsCopy,
  type FocusBlock,
} from '../lib/focus.ts';
import {
  REVEAL,
  blockText,
  createReveal,
  revealComplete,
  tickReveal,
  type RevealState,
} from '../lib/reveal.ts';

/** The focus view prints at 16 cps; `duration = chars / cps`, so it is a speed, not a skip. */
const FOCUS_SPEED = 16 / REVEAL.cps;

export type FocusViewProps = {
  change: ChangeDto | null;
  impact: ChangeImpactDto | null;
  /** The server does not know this change: an old or a mistyped link, never invented. */
  missing: boolean;
  ribbon: Ribbon | null;
  /** `hello.limits.maxWave`: the wave bound the server runs under (fallback until it lands). */
  maxWave?: number;
  revisions: Record<number, ChapterRevisionPayload>;
  onClose: () => void;
};

/**
 * The focus view («прицел», ARCHITECTURE §11.9, ADR-032, DESIGN §7.14).
 *
 * A mode of the same page, not a second page: `#правка-<id>` selects one change, the page
 * behind goes dark, and one lit sheet shows only the blocks that change moved — printed at
 * a human pace from the landed revision (ADR-006). While the ripple is live, the ring
 * follows `cascade:progress` and the sheet switches to the chapter being rewritten.
 *
 * The panel is built from the public change DTO and the impact projection only. There is no
 * gate section, no finding and no role name to render, because no input carries one (§6B.6).
 */
export function FocusView({ change, impact, missing, ribbon, maxWave, revisions, onClose }: FocusViewProps) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const savedOffset = useRef(0);
  const captured = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const navigating = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [following, setFollowing] = useState(true);
  const [manual, setManual] = useState<number | null>(null);
  const [blocks, setBlocks] = useState<FocusBlock[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState<RevealState | null>(null);

  // One session: remember where the reader was, lock the page, trap focus, restore on exit.
  useEffect(() => {
    // Captured once: StrictMode's probe mount must not replace the reader's real offset.
    if (!captured.current) {
      savedOffset.current = window.scrollY;
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      captured.current = true;
    }
    document.body.classList.add('is-focus');
    // §11.9 rule 1: the page behind is still legible but inert while the sheet is lit.
    const release = inertBackground(dialog.current);
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key === 'Tab') trapFocus(event, dialog.current);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('is-focus');
      release();
      const target = exitTarget(savedOffset.current, navigating.current);
      if (target.kind === 'chapter') scrollToChapter(target.chapter);
      else window.scrollTo(0, target.offset);
      navigating.current = null;
      trigger.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    setManual(null);
    setFollowing(true);
  }, [change?.id]);

  const liveChapter = useMemo(() => {
    if (change === null || ribbon === null || ribbon.changeId !== change.id) return null;
    if (change.status !== 'processing') return null;
    return ribbon.step;
  }, [change, ribbon]);

  const chapter = change === null ? null : sheetChapter(change, following ? ribbon : null, manual);
  const stage = change === null ? 'edit' : focusStage(change, ribbon);
  const wings = change === null ? { down: null, up: null } : focusWings(change, ribbon);
  const wave = change === null ? 0 : waveOf(change);
  /** The server announces its own wave bound; the constant is only the pre-`hello` fallback. */
  const bound = ribbonMaxWave(maxWave);
  const revision = chapter === null ? null : (revisions[chapter] ?? null);

  // The changed blocks: the live patch when the step just landed, the change log otherwise.
  useEffect(() => {
    if (change === null || chapter === null || !canPrint(change)) {
      setBlocks(null);
      setLoading(false);
      return;
    }
    if (revision !== null && revision.n === chapter && revision.cause.changeId === change.id) {
      setBlocks(blocksFromPatch(revision.patch));
      setLoading(false);
      return;
    }
    if (change.history === null) {
      setBlocks(chapter === change.chapter ? [] : null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const from = Math.max(0, change.history.fromHseq - 1);
    const to = change.history.toHseq;
    setBlocks(null);
    setLoading(true);
    void Promise.all([getHistoryDiff(from, to, chapter), getHistoryChapter(chapter, to)])
      .then(([diff, snapshot]) => {
        if (cancelled) return;
        if (snapshot === null) {
          setBlocks([]);
          return;
        }
        const ops: HistoryDiffOpDto[] = diff.ops.filter((op) => op.changeId === change.id);
        setBlocks(changedBlocksFromDiff(ops, chapter, snapshot.blocks as BlockDto[]));
      })
      .catch(() => {
        if (!cancelled) setBlocks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [change, chapter, revision]);

  const printable = useMemo(
    () => (blocks ?? []).filter((block) => block.op !== 'removed').map(({ id, text }) => ({ id, text })),
    [blocks],
  );

  useEffect(() => {
    setReveal(printable.length === 0 ? null : createReveal(printable, { reducedMotion: reducedMotion() }));
  }, [printable]);

  const printing = reveal !== null && !revealComplete(reveal);
  useEffect(() => {
    if (!printing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const delta = Math.min(250, now - last);
      last = now;
      setReveal((current) => (current === null ? current : tickReveal(current, delta, FOCUS_SPEED)));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [printing]);

  const close = useCallback(() => closeRef.current(), []);
  const revealChapter = useCallback((n: number) => {
    navigating.current = n;
    closeRef.current();
  }, []);

  const stopFollowing = useCallback(() => {
    setFollowing(false);
    setManual((held) => held ?? liveChapter ?? null);
  }, [liveChapter]);

  const pick = useCallback((n: number) => {
    setFollowing(false);
    setManual(n);
  }, []);

  const replay = useCallback(() => {
    setReveal(printable.length === 0 ? null : createReveal(printable, { reducedMotion: reducedMotion() }));
  }, [printable]);

  if (missing) {
    return (
      <FocusShell dialog={dialog} onClose={close}>
        <div className="focus-bar">
          <span className="focus-tag">прицел</span>
          <span className="focus-n">правка не найдена</span>
          <button className="focus-exit" type="button" onClick={close}>
            выйти
          </button>
        </div>
        <p className="focus-sheet-note">ссылка ведёт на правку, которой нет · возможно, она старая</p>
      </FocusShell>
    );
  }

  if (change === null) {
    return (
      <FocusShell dialog={dialog} onClose={close}>
        <div className="focus-bar">
          <span className="focus-tag">прицел</span>
          <span className="focus-n">правка читается</span>
          <button className="focus-exit" type="button" onClick={close}>
            выйти
          </button>
        </div>
      </FocusShell>
    );
  }

  const notice = sheetNotice(change);
  const scale = focusScale([
    change.chapter,
    chapter ?? change.chapter,
    wings.down ?? change.chapter,
    wings.up ?? change.chapter,
    ...(ribbon !== null && ribbon.changeId === change.id ? ribbon.touched : []),
  ]);
  const current = liveChapter ?? chapter ?? change.chapter;
  const originPercent = scalePercent(change.chapter, scale.from, scale.to);
  const currentPercent = scalePercent(current, scale.from, scale.to);
  const cost = costLine(change, impact);
  const step = change.steps.find((entry) => entry.chapter === chapter) ?? null;
  const typed = reveal !== null && revealComplete(reveal) && printable.length > 0;

  return (
    <div
      className="focus"
      role="dialog"
      aria-modal="true"
      aria-label={`прицел · правка ${change.seq}`}
      ref={dialog}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onWheel={stopFollowing}
      onTouchMove={stopFollowing}
    >
      <div className="focus-panel">
        <div className="focus-bar">
          <span className="focus-tag">прицел</span>
          <span className="focus-n">правка {String(change.seq).padStart(3, '0')}</span>
          <button className="focus-exit" type="button" onClick={close}>
            выйти
          </button>
        </div>

        <div className="focus-body">
          <p className="focus-where">
            глава {chapterLabel(chapter ?? change.chapter)} · изменённые абзацы
            {step === null ? '' : ` · ${formatTime(step.at)}`}
          </p>

          <section className="focus-stage" aria-label="лист правки">
            <div className="focus-paper" aria-live="off">
              <i className="focus-corner" aria-hidden="true" />
              {blocks !== null && blocks.length > 0 ? (
                blocks.map((block) =>
                  block.op === 'removed' ? (
                    <p className="focus-removed" key={block.id}>
                      абзац убран
                    </p>
                  ) : (
                    <p className="focus-p" key={block.id} data-block-id={block.id}>
                      {reveal === null ? block.text : blockText(reveal, block.id, block.text)}
                    </p>
                  ),
                )
              ) : (
                <p className="focus-sheet-note">{sheetCopy(notice, change.reason, loading, change.status)}</p>
              )}
              {printing ? <span className="focus-caret" aria-hidden="true" /> : null}
            </div>
            <i className="focus-corner is-ne" aria-hidden="true" />
            <i className="focus-corner is-sw" aria-hidden="true" />
            <i className="focus-corner is-se" aria-hidden="true" />
          </section>

          {change.relevance !== null && change.relevance.evidence.length > 0 && stage === 'stale' ? (
            <ul className="focus-evidence">
              {change.relevance.evidence.slice(0, 3).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          <div className="focus-readout">
            <span>волна {wave} / {bound}</span>
            <span>{wingsCopy(wings, stage)}</span>
            <span>{stageCopy(stage)}</span>
          </div>

          <div className="focus-rings" aria-hidden="true">
            <span className="focus-axis" />
            <span
              className="focus-link"
              style={{
                left: `${Math.min(originPercent, currentPercent)}%`,
                width: `${Math.abs(currentPercent - originPercent)}%`,
              }}
            />
            {scaleTicks(scale.from, scale.to).map((n) => (
              <span key={`tick-${n}`}>
                <span className="focus-tick" style={{ left: `${scalePercent(n, scale.from, scale.to)}%` }} />
                <span className="focus-tick-label" style={{ left: `${scalePercent(n, scale.from, scale.to)}%` }}>
                  {chapterLabel(n)}
                </span>
              </span>
            ))}
            <span className="focus-origin" style={{ left: `${originPercent}%` }} />
            <span className="focus-ring" style={{ left: `${currentPercent}%` }} data-chapter={current} />
          </div>

          <section className="focus-note" aria-label={footnoteCopy(change)}>
            <header className="focus-note-h">
              <span>{footnoteCopy(change)}</span>
              <span className="focus-stamp">{panelStamp(change)}</span>
            </header>
            <dl className="focus-rows">
              <div>
                <dt>основание</dt>
                <dd>{basisCopy(change)}</dd>
              </div>
              <div>
                <dt>что меняется</dt>
                <dd className="focus-intent">«{change.intent}»</dd>
              </div>
              <div>
                <dt>что внесло</dt>
                <dd>
                  {change.steps.length === 0 ? (
                    <span className="focus-quiet">{change.status === 'void' ? 'шагов нет' : 'формируется'}</span>
                  ) : (
                    <ol className="focus-steps">
                      {change.steps.map((entry) => (
                        <li key={`${entry.seq}-${entry.at}`}>
                          {typeof entry.chapter === 'number' ? (
                            <button
                              type="button"
                              className={entry.chapter === chapter ? 'is-on' : ''}
                              onClick={() => pick(entry.chapter as number)}
                            >
                              <span aria-hidden="true">{wingGlyph(entry)}</span> {stepLabel(entry)}
                            </button>
                          ) : (
                            <span>
                              <span aria-hidden="true">{wingGlyph(entry)}</span> {stepLabel(entry)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </dd>
              </div>
              <div>
                <dt>затронуто</dt>
                <dd>{touchedChaptersCopy(change, impact)}</dd>
              </div>
              <div>
                <dt>оценка</dt>
                <dd>
                  {assessmentCopy(change, ribbon, bound)}
                  {change.relevance === null || change.relevance.grade === 'fresh' ? null : (
                    <span className="focus-quiet"> · {relevanceCopy(change.relevance.grade)}</span>
                  )}
                </dd>
              </div>
              {cost === null ? null : (
                <div>
                  <dt>цена</dt>
                  <dd className="focus-cost">{cost}</dd>
                </div>
              )}
              <div>
                <dt>итерация</dt>
                <dd>{iterationCopy(change, bound)}</dd>
              </div>
            </dl>
            {change.reason === null ? null : <p className="focus-reason">{change.reason}</p>}
          </section>
        </div>

        <div className="focus-actions">
          {chapter === null ? null : (
            <button type="button" className="focus-action" onClick={() => revealChapter(chapter)}>
              к главе {chapter}
            </button>
          )}
          <button
            type="button"
            className={`focus-action${following ? ' is-on' : ''}`}
            aria-pressed={following}
            onClick={() => {
              setFollowing((held) => {
                if (!held) setManual(null);
                return !held;
              });
            }}
          >
            {following ? 'слежу' : 'следовать'}
          </button>
          {typed ? (
            <button type="button" className="focus-action" onClick={replay}>
              ещё раз
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Keep Tab inside the dialog (§DESIGN 10: a modal owns the keyboard while it is open). */
function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (root === null) return;
  const focusable = [...root.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')].filter(
    (element) => !element.hasAttribute('disabled'),
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

