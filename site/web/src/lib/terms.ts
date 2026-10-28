/**
 * The terms a reader accepts — now defined once in `@book/shared`.
 *
 * The server hashes the exact text a reader accepts and records the version on the row, so the
 * strings cannot live on one side of the wire only. This module is a re-export barrel: every
 * surface keeps its old import path (`'../lib/terms.ts'`, `'./terms.ts'`) and no second copy of
 * a sentence exists to drift from the record (BOOK-58).
 */
export {
  MACHINE_TOOL_CAVEAT,
  MACHINE_TOOL_RULES,
  RECEIPT_RIGHTS,
  RIGHTS_ASSIGNMENT,
  RIGHTS_FALLBACK,
  RIGHTS_RETAINED,
  SUBMIT_LINE,
  TERMS_VERSION,
  TOOL_CLAUSE,
  acceptedTermsText,
  receiptLine,
} from '@book/shared';
