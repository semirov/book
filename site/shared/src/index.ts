export * from './book.ts';
export * from './frame.ts';
export * from './pages.ts';
export * from './types.ts';
export * from './protocol.ts';
export * from './change.ts';
export * from './history.ts';
export * from './authors.ts';
export * from './cost.ts';
export * from './publicChange.ts';
export * from './captcha.ts';
export * from './comment.ts';
export * from './terms.ts';
export * from './intervention.ts';
export * from './decisions.ts';
export * from './injection.ts';
export * from './intent.ts';
export * from './stage.ts';
export * from './sentences.ts';
export * from './push.ts';

/**
 * The validator is used by the site's integrity panel and by the commit gate, so the parts
 * they need are exported by name. A bare `export *` would collide with `Imprint` and
 * `LegalDenylist`, which `book.ts` already owns.
 */
export { runValidation } from './validate/rules.ts';
export { buildNameIndex, compilePatterns, findDenylistedNames } from './validate/denylist.ts';
export type { DenylistHit, NameIndex } from './validate/denylist.ts';
export { checkCommitScope, commitSubject, isBookFile, isSweep, stagedBookFiles, SWEEP_PREFIX } from './validate/commit.ts';
export type {
  // `Finding` is already `change.ts`'s (a gate's finding); the validator's own record of a
  // broken rule is exported under its qualified name so the two cannot be confused.
  Finding as ValidatorFinding,
  ManuscriptFile,
  PlanningFile,
  RuleId,
  Severity,
  ValidateOptions,
  ValidateResult,
} from './validate/text.ts';
