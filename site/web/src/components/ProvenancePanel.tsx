import type { AnchorRect } from '../lib/popover.ts';
import type { ProvenanceView } from '../lib/provenance.ts';
import { SeamPanel } from './SeamPanel.tsx';

/**
 * BOOK-DOC-34 §2.6 — «откуда это слово», the DNA panel.
 *
 * BOOK-111 (owner, 2026-10-27) — one shell, two contexts, one ✕: the `<aside>` is `SeamPanel`'s.
 * This file is the surface's name and its own class, nothing else — it owns no placement, no
 * focus and no `Escape`, so the box cannot put two of any of them on the page.
 *
 * `prov-panel ym-hide-content` is the masked root the Webvisor guard (BOOK-77) reads here, and
 * the very string the shell is told to wear: one literal, no copy to drift.
 */
export const PROV_PANEL_CLASS = 'prov-panel ym-hide-content';

export function ProvenancePanel({
  view,
  anchor,
  onClose,
  onForm,
  onFiling,
  filingLabel,
}: {
  view: ProvenanceView;
  anchor: AnchorRect | null;
  onClose: () => void;
  onForm?: () => void;
  /** The seam's sentence holds a filing: the same box turns into its card. */
  onFiling?: () => void;
  filingLabel?: string;
}) {
  return (
    <SeamPanel
      context="provenance"
      rootClass={PROV_PANEL_CLASS}
      view={view}
      anchor={anchor}
      onClose={onClose}
      onForm={onForm}
      onFiling={onFiling}
      filingLabel={filingLabel}
    />
  );
}
