/**
 * The harm lock's question, rewritten to the owner's ruling (2026-10-29):
 *
 *   *is this telling a story about harm, giving a reader a means to harm, or pointing at a real
 *   person?*
 *
 * The book is 18+. Injury, blood, a paper cut, illness, death, violence, medical and forensic
 * detail, the world's cruelty, a child in danger as a plot fact — all of that is the genre and
 * **passes**. Only four things are refused, and the tables here are those four and nothing else:
 *
 *   1. a **procedure** a real reader could follow — a recipe, a method, a synthesis, a dose —
 *      stated as steps rather than told as a story (`PROCEDURE_FRAME` + `PROCEDURE_HARM`);
 *   2. a **real, identifiable person** pointed at (`REAL_WORLD_MARKERS`);
 *   3. **sexual content involving a minor**, in any framing, with no request word required
 *      (`MINOR_SEXUAL`);
 *   4. material **unlawful to publish at all** (`UNPUBLISHABLE_MARKERS`), and only when the
 *      reader asks the book to carry it.
 *
 * The cut this replaced was a bare noun plus a request word — «опиши подробно про наркотик» was
 * refused as illegal — which made the book's own register (drugs, weapons, suicide, death) a
 * lock. That is the over-block the ruling removed: a noun is not a means, and a story is not a
 * recipe.
 *
 * These are pre-filter tables, never the defence: Gate B's reading is what refuses a real text.
 * The patterns are the questions a machine can ask; they are deliberately narrow, and a hit here
 * is a *possible* finding, named by the case it belongs to.
 */

import { HARM_CASE_FLAGS } from './disposition.ts';

/** The refusal line per harm case: the gate's own «проверяется: …», never a blanket claim. */
export const ILLEGAL_REASONS = {
  instructions: 'проверяется: инструкция, как причинить вред',
  'minor-sexual': 'проверяется: сексуальное содержание с ребёнком',
  unpublishable: 'проверяется: незаконное содержимое',
} as const;

/**
 * Case 1 — the frame that makes text an instruction rather than a scene: how to make, mix,
 * synthesize or obtain something. «Инструкция по эксплуатации» is a document, not a how-to, so
 * the bare noun is not a frame; the request word is not required, because a followable recipe is
 * a means whatever its framing.
 */
export const PROCEDURE_FRAME =
  /(?:рецепт|пропорци|пошагов|по\s+пунктам|как\s+(?:сделать|собрать|изготовить|приготовить|получить|отравить|взорвать|причинить|навредить)|способ\s+(?:изготов|сделат|собрат|получ|отрав|взорв|причин)|инструкци[а-яё]*\s+(?:как|по\s+(?:изготовлени|приготовлени|сборк))|сварить|синтезировать)[а-яё]*/u;

/** The harm a procedure does outside the book: a substance, a device, or harm itself. */
export const PROCEDURE_HARM =
  /(?<![а-яё])яд(?:а|у|ом|ы|ов)?(?![а-яё])|отрав|бомб|взрывчат|взрывн[а-яё]*\s+устройств|тротил|оруж[иея]|наркотик|метамфетамин|амфетамин|героин|кокаин|мефедрон|фентанил|рицин|вред|покалеч/u;

/**
 * Case 3 — the absolute one: a minor and sexual content, in any framing, softened by no request
 * word and by no literary purpose. «Секс» is bounded so «секция» is not a match; a child in
 * danger with no sexual marker is a plot fact, not this case.
 */
export const MINOR_SEXUAL: readonly RegExp[] = [
  /детск[а-яё]*\s+порнограф/u,
  /порнограф[а-яё]*[^.!?\n]{0,30}(?:дет|ребён|ребен|малолет|несовершеннолетн)/u,
  /(?:несовершеннолетн|малолетн|ребён|ребен|детск)[а-яё]*[^.!?\n]{0,30}(?:секс(?:а|у|ом|е)?(?![а-яё])|порн|интимн|эротич|развратн|гол(?:ый|ая|ое|ые)|педофил)/u,
  /(?:секс(?:а|у|ом|е)?(?![а-яё])|порн|интимн|эротич|развратн|гол(?:ый|ая|ое|вые)|педофил)[^.!?\n]{0,30}(?:несовершеннолетн|малолетн|ребёнк|ребенк|детск|школьниц|школьник|подрост)[а-яё]*/u,
];

/**
 * Case 4 — what is unlawful to publish whatever the framing: a call to violence or to the
 * overthrow of power, incitement of hatred, the justification of terrorism, the rehabilitation
 * of nazism, recruitment. The reader must be asking for it, so a scene *about* such a leaflet is
 * not this case.
 */
export const UNPUBLISHABLE_MARKERS =
  /(экстремизм|терроризм|террорист|разжигани|реабилитаци[а-яё]*\s+нацизм|оправдани[а-яё]*\s+терроризм|вербовк[а-яё]*\s+(?:в\s+)?(?:террорист|боевик)|призыв[а-яё]*\s+к\s+(?:насили|свержени|сверженью|вражд|ненавист))/u;

/**
 * Case 2 — a real, identifiable person pointed at: a named public figure, or another author's
 * protected hero. A first name alone is not a person; Gate B's name index is the precise check.
 */
export const REAL_WORLD_MARKERS =
  /(путин|навальн|трамп|байден|маск|зеленск|гарри\s+поттер|шерлок\s+холмс|батман|человек-паук|супермен|микки\s+маус|дисней|голливуд|real\s+person|celebrity|politician|famous\s+person)/u;

/** The words that make a sentence a request to the book rather than a statement about it. */
export const REQUEST_WORDS =
  /(добав|введ|встав|напиш|опиши|пропиш|сдела|изобраз|расскаж|пусть|созда|придум|change|add|write|make)/u;

/** Does a marker and a request word share one sentence? A note about the subject is not a request. */
export function asksInOneSentence(
  lower: string,
  sentences: ReadonlyArray<{ text: string }>,
  markers: RegExp,
): boolean {
  return markers.test(lower) && sentences.some(({ text }) => markers.test(text) && REQUEST_WORDS.test(text));
}

/**
 * The three illegal cases, in the order they are asked: a child (absolute, no request needed), a
 * recipe (a frame and a harm object in one sentence), the law (a marker the reader asks to put
 * in the book). Null means: nothing here refuses, and the gate's own question is next.
 */
export function illegalFinding(
  lower: string,
  sentences: ReadonlyArray<{ text: string }>,
): { flag: string; reason: string } | null {
  if (sentences.some(({ text }) => MINOR_SEXUAL.some((pattern) => pattern.test(text)))) {
    return { flag: HARM_CASE_FLAGS['minor-sexual'], reason: ILLEGAL_REASONS['minor-sexual'] };
  }
  if (sentences.some(({ text }) => PROCEDURE_FRAME.test(text) && PROCEDURE_HARM.test(text))) {
    return { flag: HARM_CASE_FLAGS.instructions, reason: ILLEGAL_REASONS.instructions };
  }
  if (asksInOneSentence(lower, sentences, UNPUBLISHABLE_MARKERS)) {
    return { flag: HARM_CASE_FLAGS.unpublishable, reason: ILLEGAL_REASONS.unpublishable };
  }
  return null;
}
