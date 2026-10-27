/**
 * The comment guard (ARCHITECTURE.md §12.5) — a pre-filter, never the defense.
 *
 * Two public outcomes and nothing else:
 *   • `rejected`   — a hard scope violation (book shape, canon): public reason, not delivered;
 *   • `quarantined`— a possible instruction, or a real-world/illegal request: stored, shown
 *                    to the reader as «проверяется», never delivered. An operator may release.
 *
 * Everything else passes untouched. The framing (§12.3), the triage decision, the intent
 * schema and the post-write validator are what actually protect the book.
 */

import { classifyText, type GuardHit } from '@book/shared';

export type GuardOutcome = {
  status: 'new' | 'rejected' | 'quarantined';
  guard: 'legal' | 'instruction' | null;
  reason: string | null;
  flags: string[];
};

const PASS: GuardOutcome = { status: 'new', guard: null, reason: null, flags: [] };

/** Rejected is stronger than quarantined; between two quarantines the first hit is reported. */
function rank(hit: GuardHit): number {
  return hit.category === 'shape' || hit.category === 'canon' ? 2 : 1;
}

export function classifyComment(body: string, proposedText: string | null): GuardOutcome {
  const hits: GuardHit[] = [];
  const bodyHit = classifyText(body);
  if (bodyHit !== null) hits.push(bodyHit);
  if (proposedText !== null) {
    const proposedHit = classifyText(proposedText);
    if (proposedHit !== null) hits.push(proposedHit);
  }
  if (hits.length === 0) return PASS;

  const strongest = hits.reduce((best, hit) => (rank(hit) > rank(best) ? hit : best), hits[0] as GuardHit);
  const flags = [...new Set(hits.map((hit) => hit.flag))];
  if (rank(strongest) === 2) {
    return { status: 'rejected', guard: 'legal', reason: strongest.reason, flags };
  }
  return {
    status: 'quarantined',
    guard: strongest.category === 'instruction' ? 'instruction' : 'legal',
    reason: strongest.reason,
    flags,
  };
}
