/**
 * BOOK-173 §4 — **how** a pass wrote. `patch` replaces a stretch inside one block (a character
 * edit; `sentences/transform.ts` keeps the sentence ids), `rewrite` writes the chapter.
 *
 * The word lives in `shared` because two sides state it: the writer chooses it
 * (`writer/mode.ts`) and the engine records it with the change (`change_plans.mode`, or the
 * close of a step that has no plan). `ChangeOutcome` is the *result*; this is the method.
 */
export type WriteMode = 'patch' | 'rewrite';
