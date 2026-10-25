import type { EscalationMarker, Ribbon } from '../lib/cascade.ts';
import { ribbonBand, ribbonDotPercent, ribbonSummary } from '../lib/cascade.ts';
import { boundaryLabel } from '../lib/changeStatus.ts';

/**
 * The cascade ribbon (ARCHITECTURE §11.7, DESIGN §7.2): a 4 px strip under the spine that
 * exists only while something is happening. It covers *those chapters*, never the book: an
 * origin tick, a dot per touched chapter, a tick at the step in flight, and — separately —
 * a dashed hairline for every escalated seam, which stays until a change or a sweep repairs
 * it. Tapping the ribbon opens the change card; tapping a seam opens the change that left it.
 */
export function CascadeRibbon({
  ribbon,
  markers,
  onOpenChange,
}: {
  ribbon: Ribbon | null;
  markers: EscalationMarker[];
  onOpenChange: (changeId: string) => void;
}) {
  if (ribbon === null && markers.length === 0) return null;
  const label = ribbon === null ? 'стык пересматривается' : ribbonSummary(ribbon);

  return (
    <div className={`ribbon${ribbon === null ? ' is-quiet' : ''}`} role="group" aria-label={label}>
      {ribbon !== null ? (
        <button
          className="ribbon-hit"
          type="button"
          onClick={() => onOpenChange(ribbon.changeId)}
          aria-label={`${label} · открыть карточку правки`}
        >
          <span className="ribbon-band" style={ribbonBand(ribbon)} aria-hidden="true" />
          {[0, 1, 2].map((ring) => (
            <span
              key={`ring-${ring}`}
              className="ribbon-ring"
              style={{
                left: `${ribbonDotPercent(ribbon.step ?? ribbon.chapter)}%`,
                animationDelay: `${ring * 870}ms`,
              }}
              aria-hidden="true"
            />
          ))}
          <span
            className="ribbon-origin"
            style={{ left: `${ribbonDotPercent(ribbon.chapter)}%` }}
            aria-hidden="true"
          />
          {ribbon.touched.map((chapter) => (
            <span
              key={chapter}
              className={`ribbon-dot${ribbon.rewritten.includes(chapter) ? ' is-written' : ''}`}
              style={{ left: `${ribbonDotPercent(chapter)}%` }}
              aria-hidden="true"
            />
          ))}
          {ribbon.step !== null ? (
            <span className="ribbon-step" style={{ left: `${ribbonDotPercent(ribbon.step)}%` }} aria-hidden="true" />
          ) : null}
        </button>
      ) : null}

      {markers.map((marker) => (
        <button
          key={marker.key}
          className="ribbon-seam"
          type="button"
          style={{ left: `${marker.percent}%` }}
          title={marker.note === null ? 'стык пересматривается' : `стык пересматривается · ${marker.note}`}
          aria-label={`стык пересматривается · ${boundaryLabel(marker.boundary)}${
            marker.note === null ? '' : ` · ${marker.note}`
          }`}
          onClick={() => {
            if (marker.changeId !== null) onOpenChange(marker.changeId);
          }}
        >
          <span className="ribbon-seam-label">стык пересматривается</span>
        </button>
      ))}
    </div>
  );
}
