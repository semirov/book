/**
 * Gate B's closed tables (BOOK-61, BOOK-DOC-42 §3).
 *
 * Two lists live here and nowhere else, because both are **hand-edited** decisions with a
 * recorded reason, never a generated view of the corpus (ADR-022): an automatic refresh would
 * make the gate agree with whatever the writer did.
 *
 * **The stop list** is the nine categories the law names. Each entry carries the reason it is
 * an entry, in the design's own wording, so a reader of this file can argue with a line rather
 * than with a regex. The patterns are deliberately narrow: they match the *offer* («рецепт …
 * метамфетамин»), not the noun, because the book's register is full of weapons, courts and
 * death, and a list that refuses a noun refuses the book.
 *
 * `STOP-PERSON` has no pattern of its own: a person is a **name**, and names are matched
 * against `PUBLIC_FIGURES` below. The entry stays in this table so the nine categories have
 * one shape and one place for their reason.
 *
 * **The public figures** are the curated list §3 means by "a full-name shape". It is short on
 * purpose and mirrors the F005 denylist (`config/legal.denylist.json`): both are hand-kept,
 * both are reviewed by the owner, and neither is derived from the book. Matching uses the
 * validator's own complete-name matcher (`buildNameIndex`/`findDenylistedNames`), so a case
 * form («с Владимиром Путиным») is the name and a first name alone is not.
 *
 * This module is server-only: `web/src` and `@book/shared` must never import it (asserted by
 * `server/test/rights/scan.test.ts`), because the SPA is bundled and a stop list in the bundle
 * is a map of the detector.
 */

/** The nine categories of BOOK-DOC-42 §3, in the order the page lists them. */
export type StopRuleId =
  | 'STOP-EXTREMISM'
  | 'STOP-TERROR'
  | 'STOP-HATE'
  | 'STOP-DRUGS'
  | 'STOP-WEAPON'
  | 'STOP-MINOR'
  | 'STOP-SELFHARM'
  | 'STOP-DEFAME'
  | 'STOP-PERSON';

export const STOP_RULES: readonly StopRuleId[] = [
  'STOP-EXTREMISM',
  'STOP-TERROR',
  'STOP-HATE',
  'STOP-DRUGS',
  'STOP-WEAPON',
  'STOP-MINOR',
  'STOP-SELFHARM',
  'STOP-DEFAME',
  'STOP-PERSON',
];

/**
 * One closed-table entry. `id` is either a `STOP-…` id or a `test:…` id injected by a test
 * through `scanRights`'s options — the `test:` prefix is enforced, so production cannot grow a
 * private list and a test never has to ship a real slur to prove the rule.
 */
export type StopEntry = {
  id: string;
  /** Why this entry exists — the design's wording, operator-facing, never printed to a reader. */
  reason: string;
  patterns: readonly RegExp[];
};

/**
 * The nine categories. The reasons are §3's own lines, kept verbatim so the table and the
 * page cannot drift into two different claims about the same entry.
 */
export const STOP_LIST: readonly StopEntry[] = [
  {
    id: 'STOP-EXTREMISM',
    reason: 'призывы к насилию, к свержению власти, реабилитация нацизма',
    patterns: [
      /призыв[а-яё]*\s+к\s+(?:насили|свержени|сверженью|убийству)/u,
      /реабилитаци[а-яё]*\s+нацизм/u,
      /разжигани[а-яё]*\s+(?:национал|межнационал|религиозн)[а-яё]*\s+вражд/u,
    ],
  },
  {
    id: 'STOP-TERROR',
    reason: 'оправдание терроризма, инструкции, вербовка',
    patterns: [
      /оправдани[а-яё]*\s+терроризм/u,
      /инструкци[а-яё]*\s+(?:по\s+)?(?:изготовлени|сборк)[а-яё]*\s+(?:бомб|взрывн)/u,
      /вербовк[а-яё]*\s+(?:в\s+)?(?:террорист|боевик)/u,
    ],
  },
  {
    id: 'STOP-HATE',
    reason: 'вражда по национальности, религии, полу, происхождению, ориентации',
    patterns: [
      /разжигани[а-яё]*\s+(?:ненавист|вражд)/u,
      /призыв[а-яё]*\s+к\s+ненавист/u,
      /(?:травить|уничтожать|изгонять)[а-яё]*\s+(?:по\s+)?(?:национальност|вероисповедани|происхождени)/u,
    ],
  },
  {
    id: 'STOP-DRUGS',
    reason: 'пропаганда, инструкции по изготовлению',
    patterns: [
      /(?:рецепт|инструкци|синтез|сварить|пропорци)[а-яё]*[^.!?\n]{0,60}(?:метамфетамин|героин|кокаин|мефедрон)/u,
      /пропаганд[а-яё]*\s+наркотик/u,
    ],
  },
  {
    id: 'STOP-WEAPON',
    reason: 'инструкции по изготовлению оружия и взрывчатых веществ',
    patterns: [
      // The *instruction* is the entry, not the noun: a document may mention a weapon, and the
      // canon's own register is full of them. «Рецепт», «инструкция», «пропорции» are the frame.
      /(?:рецепт|инструкци|пропорци)[а-яё]*[^.!?\n]{0,60}(?:бомб|взрывчат|тротил|оружи)/u,
      /как\s+(?:сделать|собрать)\s+(?:бомбу|взрывчатку|оружие)/u,
    ],
  },
  {
    id: 'STOP-MINOR',
    reason: 'сексуальное содержание с несовершеннолетними, вовлечение их в противоправное',
    patterns: [
      /детск[а-яё]*\s+порнограф/u,
      /(?:несовершеннолетн|малолетн)[а-яё]*[^.!?\n]{0,30}(?:секс|порн|интимн)/u,
      /вовлечени[а-яё]*\s+несовершеннолетн/u,
    ],
  },
  {
    id: 'STOP-SELFHARM',
    reason: 'инструкции по причинению вреда себе',
    patterns: [
      /инструкци[а-яё]*[^.!?\n]{0,40}(?:самоубийств|суицид)/u,
      /способ[а-яё]*\s+(?:покончить\s+с\s+собой|самоубийств)/u,
    ],
  },
  {
    id: 'STOP-DEFAME',
    reason: 'заведомо ложное утверждение о реальном человеке',
    patterns: [
      /распростран[а-яё]*\s+заведомо\s+ложн/u,
      /оклевета[а-яё]*\s+[А-ЯЁ][а-яё]+/u,
    ],
  },
  {
    id: 'STOP-PERSON',
    reason: 'реальный живущий человек как герой; охраняемый персонаж чужой книги',
    patterns: [],
  },
];

/**
 * A full name the book may not carry as its own (BOOK-DOC-42 §3, REFUSED, not releasable).
 *
 * Closed and explicit: the F005 denylist's `persons` and `characters`, plus nothing. A false
 * positive is fixed by editing this list with a recorded reason, never by an exception in a
 * prompt (the same rule F005 states).
 */
export const PUBLIC_FIGURES: readonly string[] = [
  // Real living people — appearing as a character is a legal problem (§3, STOP-PERSON).
  'Владимир Путин',
  'Александр Лукашенко',
  'Дональд Трамп',
  'Илон Маск',
  // Protected characters of another author's book.
  'Гарри Поттер',
  'Гэндальф',
  'Бэтмен',
  'Чебурашка',
];
