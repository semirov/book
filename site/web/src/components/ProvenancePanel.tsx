import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePanel } from '../lib/cssom.ts';
import { placePopover, samePlacement, type AnchorRect, type PopoverPlacement } from '../lib/popover.ts';
import { frozenActionHref, type ProvenanceView } from '../lib/provenance.ts';

const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-DOC-34 §2.6 — «откуда это слово», the DNA panel.
 *
 * It reuses the site's one placement mechanism (`placePopover` + `placePanel` over CSSOM), so
 * there is no second geometry and no scroll listener: measured once per open, `position:
 * fixed`, the page keeps scrolling underneath. `role="dialog"`, `aria-modal="false"`, focus
 * moves in and returns to its anchor on close; `Esc` closes it, and `Tab` is not trapped
 * because the panel is not modal (§7).
 */
export function ProvenancePanel({
  view,
  anchor,
  onClose,
  onForm,
}: {
  view: ProvenanceView;
  anchor: AnchorRect | null;
  onClose: () => void;
  onForm?: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  useMeasuredLayout(() => {
    if (anchor === null) return;
    const node = panel.current;
    if (node === null || typeof window === 'undefined') return;
    const size = { width: Math.min(420, window.innerWidth - 24), height: node.scrollHeight };
    const next = placePopover(anchor, size, { width: window.innerWidth, height: window.innerHeight });
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchor, view]);

  useMeasuredLayout(() => {
    placePanel(panel.current, placement);
  }, [placement]);

  // §7: focus moves into the panel on open; the caller returns it to the trigger on close.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // BOOK-77 (audit F1): chain values and rows carry a reader's label, so both placements of
  // the panel are masked.
  return (
    <aside
      className={`prov-panel ym-hide-content${placement === null ? '' : ' prov-panel-anchored'}`}
      role="dialog"
      aria-modal="false"
      aria-label={view.title}
      ref={panel}
      tabIndex={-1}
    >
      <div className="prov-head">
        <span className="prov-label">{view.title}</span>
        <button type="button" className="prov-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      <p className="prov-word">
        {view.word} <span className="prov-chapter">{view.chapterLine}</span>
      </p>
      <ol className="prov-chain">
        {view.chain.map((node) => (
          <li key={node.label} className="prov-node">
            <span className="prov-node-label">{node.label}</span>
            <span className="prov-node-value">{node.value}</span>
          </li>
        ))}
      </ol>
      <dl className="prov-rows">
        {view.rows.map((row) => (
          <div className="prov-row" key={row.label} data-quiet={row.quiet === true ? 'true' : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {view.copy === null ? null : <p className="prov-copy">{view.copy}</p>}
      {view.action.kind === 'rules' ? (
        <a className="prov-rules" href={frozenActionHref()}>
          {view.action.label}
        </a>
      ) : (
        <button type="button" className="prov-action" onClick={onForm}>
          {view.action.label}
        </button>
      )}
    </aside>
  );
}
