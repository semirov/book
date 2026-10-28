/**
 * BOOK-181 — the plan a pass promises, and the judge that checks it against the text.
 *
 * §1 of the writer's brief names five fields; until now nothing carried them to the editor's
 * gate, so the gate judged prose blind to what the chapter had promised. The plan is data: the
 * pass attaches it to the text under review, the editor reads both, and the judge answers one
 * verdict per field.
 *
 * A deliberately static chapter is legal — `документ` or `тишина` — but only when the plan says
 * what the stillness pays and who pays it.
 */

export type FrictionKind = 'procedural' | 'physical' | 'psychological';

export type ChapterPlan = {
  /** The protagonist's unchosen physical act and its price. `null` only with a static declaration. */
  act: { what: string; cost: string; payer: string } | null;
  friction: { kind: FrictionKind; object: string; move: string } | null;
  metaphor: { image: string; glosses: number } | null;
  want: string;
  /** The register the chapter turns to, and its reference (the neighbour, or the canon). */
  register_intent: string;
  /** Stillness, declared with its reason and its payer: the act is then not demanded. */
  static?: { kind: 'документ' | 'тишина'; reason: string; payer: string } | null;
};

/** The five answers the judge gives, in the order the editor reads them. */
export type PlanFieldVerdict =
  | 'act: ok' | 'act: absent' | 'act: unpaid'
  | 'friction: ok' | 'friction: detached'
  | 'metaphor: ok' | 'metaphor: second' | 'metaphor: glossed'
  | 'want: ok' | 'want: absent'
  | 'register: ok' | 'register: unearned';
