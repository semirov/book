import type { EscalationMarker, Ribbon, RibbonWing, Wing } from '../lib/cascade.ts';
import { WING_WORDS, ribbonSummary, rippleIsLive, wingLine } from '../lib/cascade.ts';
import { boundaryLabel } from '../lib/changeStatus.ts';

/**
 * The cascade ribbon (ARCHITECTURE §11.7, BOOK-DOC-4): the change's consequence as two wings.
 *
 * The ripple is visible in both directions at once — rings spreading down toward chapter 1
 * and up toward chapter 42 — and the reader may follow either wing. Each wing prints its own
 * wave, its state and the chapters it reached, from the cascade DTO; a wing that never opened
 * prints nothing and is skipped (BOOK-137): the reading surface never prints the machinery's
 * own condition. Rings appear only while a step is in flight, so no animation exists without
 * a live cascade.
 *
 * Every chapter is a link to its own place in the book; a wing's state opens the change in the
 * record at the sentence it touched.
 * No inline style: the layout is classes and data attributes (CSP forbids inline styles).
 */
export function CascadeRibbon({
  ribbon,
  markers,
  onOpenChange,
  live,
}: {
  ribbon: Ribbon | null;
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
  /** BOOK-56: the cascade is history; without a reader change it is not rendered at all. */
  live: boolean;
}) {
  if (!live) return null;
  if (ribbon === null && markers.length === 0) return null;
  const rippleLive = rippleIsLive(ribbon);
  const label = ribbon === null ? 'стык пересматривается' : ribbonSummary(ribbon);

  return (
    <div className={`ribbon${ribbon === null ? ' is-quiet' : ''}`} role="group" aria-label={label}>
      {ribbon === null ? null : (
        <div className="ribbon-wings">
          <WingColumn side="down" wing={ribbon.wings.down} />
          <div className="ribbon-origin">
            <a
              className="ribbon-ch is-origin"
              href={`#ch-${ribbon.chapter}`}
              aria-label={`глава ${ribbon.chapter} — отсюда пошла правка`}
            >
              <span className="ribbon-ch-g">{ribbon.chapter}</span>
            </a>
            <button
              className="ribbon-open"
              type="button"
              onClick={() => onOpenChange(ribbon.changeId)}
              aria-label={`${label} · открыть карточку правки`}
            >
              правка
            </button>
          </div>
          <WingColumn side="up" wing={ribbon.wings.up} />
        </div>
      )}

      {rippleLive ? (
        <span className="ribbon-rings" aria-hidden="true">
          {[0, 1, 2].map((ring) => (
            <i key={`ring-${ring}`} className="ribbon-ring" data-ring={ring} />
          ))}
        </span>
      ) : null}

      {markers.length > 0 ? (
        <ul className="ribbon-seams">
          {markers.map((marker) => (
            <li key={marker.key}>
              <button
                className="ribbon-seam"
                type="button"
                title={marker.note === null ? 'стык пересматривается' : `стык пересматривается · ${marker.note}`}
                aria-label={`стык пересматривается · ${boundaryLabel(marker.boundary)}${
                  marker.note === null ? '' : ` · ${marker.note}`
                }`}
                onClick={() => {
                  if (marker.changeId !== null) onOpenChange(marker.changeId);
                }}
              >
                <span className="ribbon-seam-label">стык пересматривается</span>
                <span className="ribbon-seam-boundary">{boundaryLabel(marker.boundary)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One wing: its wave and state in words, then every chapter it reached as a link. */
function WingColumn({ side, wing }: { side: Wing; wing: RibbonWing }) {
  const line = wingLine(side, wing);
  // BOOK-137: a wing that never opened has nothing to say — no state word, no diagnostic, no
  // empty column. The origin in the middle stays, so the ribbon still names the change's home.
  if (line === '' && wing.reached.length === 0) return null;
  return (
    <div className={`ribbon-wing is-${side}`} data-state={wing.state}>
      {line === '' ? null : <span className="ribbon-wing-h">{line}</span>}
      {wing.reached.length === 0 ? null : (
        <span className="ribbon-reached">
          {wing.reached.map((chapter) => (
            <a
              key={chapter}
              className="ribbon-ch"
              href={`#ch-${chapter}`}
              aria-label={`глава ${chapter}, ${WING_WORDS[side]}`}
            >
              <span className="ribbon-ch-g">{chapter}</span>
            </a>
          ))}
        </span>
      )}
    </div>
  );
}
