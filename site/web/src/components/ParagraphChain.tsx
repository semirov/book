import type { ParagraphChainDto } from '@book/shared';

import { chainHead } from '../lib/history.ts';
import { formatTime } from '../lib/format.ts';

/**
 * «откуда эта фраза» — the paragraph's lineage chain (ARCHITECTURE §6F.3).
 *
 * The chain is finite by construction: one introduction, at most one continuation per
 * version, and an erasure where it ends. The head repeats the SPEC's public copy
 * («переписано в 14:20 правкой 7 · было: правка 3 (Аня)») so the same sentence is used in
 * the chronicle, the book and the change card.
 */
export function ParagraphChain({
  chain,
  loading,
  onClose,
}: {
  chain: ParagraphChainDto | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <aside className="chain" role="dialog" aria-label="откуда эта фраза">
      <div className="chain-head">
        <span className="chain-title">откуда эта фраза</span>
        <button type="button" className="chain-close" onClick={onClose} aria-label="закрыть">
          ✕
        </button>
      </div>
      {loading ? <p className="chr-empty">цепочка читается…</p> : null}
      {!loading && chain === null ? <p className="chr-empty">у этой строки нет истории</p> : null}
      {chain === null ? null : (
        <>
          <p className="chain-line">{chain.line}</p>
          <p className="chain-state">{chainHead(chain)}</p>
          <ol className="chain-list">
            {chain.versions.map((version) => (
              <li key={`${version.blockUid}-${version.ver}`} className={`chain-row op-${version.op}`}>
                <span className="chain-ver">{version.ver}</span>
                <span className="chain-copy">
                  {version.op === 'introduced' ? 'написано' : version.op === 'revised' ? 'переписано' : 'убрано'}
                  {' · '}
                  {formatTime(version.at)}
                  {version.actor?.label ? ` · ${version.actor.label}` : ''}
                </span>
                <code className="chain-id">{version.blockId}</code>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
