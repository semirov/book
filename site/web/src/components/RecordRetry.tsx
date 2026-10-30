import type { ReactNode } from 'react';

import { RETRY_UNAVAILABLE, RETRY_WORD } from '../lib/retry.ts';
import type { Retry } from '../lib/useRetry.ts';

/**
 * BOOK-220 §11.3 — «повторить» on the record: a word, not a button-label.
 *
 * Lowercase mono 12, the register and shape of `вмешаться` (the sheet's own rule): no primary
 * button, no colour, no icon. It stands only for a failure of ours, and the cap's line takes its
 * place when the tries are spent; a repeat the endpoint would not take is said out loud, with no
 * claim of success.
 */
export function RecordRetry({ retry }: { retry: Retry }): ReactNode {
  if (retry.phase === 'unavailable') return <p className="rec-retry-line">{RETRY_UNAVAILABLE}</p>;
  if (retry.phase === 'started') return null;
  if (retry.offer.kind === 'spent') return <p className="rec-retry-line">{retry.offer.line}</p>;
  if (retry.offer.kind === 'word') {
    return (
      <button type="button" className="rec-retry" onClick={retry.run}>
        {RETRY_WORD}
      </button>
    );
  }
  return null;
}
