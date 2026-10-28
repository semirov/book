/**
 * The failure shape every step of posting returns, and the two helpers it needs.
 *
 * It lives apart from `service.ts` because the anchor resolver is its own module and both must
 * answer with the same refusal: one `code` the route branches on, one message the reader sees.
 */

export type ServiceFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  retryAfterMs?: number;
  resetAt?: string;
  currentText?: string;
  /** BOOK-158: the next UTC midnight, when a filing's day's tries come back. */
  reopenAt?: string;
  /** BOOK-111: the filing a refusal names — a duplicate's own row, so the reader can open it. */
  commentId?: string;
  /**
   * Which budget refused an edit. Internal only — the route logs it (identity and network
   * refusals are distinguishable to an operator) and never sends it to the reader.
   */
  budget?: 'identity' | 'ip';
};

export function fail(status: number, code: string, message: string, commentId?: string): ServiceFailure {
  return { ok: false, status, code, message, ...(commentId === undefined ? {} : { commentId }) };
}

export function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
