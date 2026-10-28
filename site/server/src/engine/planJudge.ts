/**
 * BOOK-181 — the editor's questions, answered by the judge in the record.
 *
 * One verdict per plan field. These are **findings**, not new vetoes: the severity decides.
 * `act: absent` (on a chapter that is not declared static) and `metaphor: glossed` are majors
 * under BOOK-179; the rest are notes the editor reads beside its own.
 */

import type { ChapterPlan, Finding, PlanFieldVerdict } from '@book/shared';

import { actWithCost, countGlosses } from './prose.ts';

/** The severity a verdict carries: only two of them are majors by themselves (BOOK-179). */
function severityOf(verdict: PlanFieldVerdict): Finding['severity'] {
  if (verdict === 'act: absent' || verdict === 'metaphor: glossed') return 'major';
  return 'minor';
}

/** Russian inflects: a plan names «пломба», the prose says «пломбу» — compare the stem. */
function mentions(text: string, word: string): boolean {
  const stem = word.trim().toLowerCase().slice(0, 5);
  return stem.length > 0 && text.toLowerCase().includes(stem);
}

function finding(verdict: PlanFieldVerdict, location: string, defect: string, fix: string): Finding {
  return { severity: severityOf(verdict), location, defect: `${verdict} — ${defect}`, fix } as Finding;
}

/** Is the chapter allowed to have no act? Only when the plan says what the stillness pays. */
export function declaredStatic(plan: ChapterPlan): boolean {
  const still = plan.static;
  return still !== null && still !== undefined && still.payer.trim().length > 0 && still.reason.trim().length > 0;
}

export function judgePlan(plan: ChapterPlan, text: string): Finding[] {
  const found: Finding[] = [];
  const still = declaredStatic(plan);

  // act — the one field where a static declaration changes the question, not the answer.
  if (plan.act === null) {
    found.push(
      still
        ? finding('act: ok', 'глава', `глава объявлена статичной (${String(plan.static?.kind)}), оплата названа`, '—')
        : finding('act: absent', 'глава', 'плана нет, поступка в тексте тоже', 'дать один поступок с ценой'),
    );
  } else if (actWithCost(text).length > 0) {
    found.push(finding('act: absent', 'глава', 'в тексте нет физического поступка', 'написать обещанный поступок'));
  } else if (!mentions(text, plan.act.payer)) {
    found.push(
      finding('act: unpaid', 'глава', `цена не оплачена тем, кто назван: ${plan.act.payer}`, 'отдать цену названному плательщику'),
    );
  } else {
    found.push(finding('act: ok', 'глава', `поступок «${plan.act.what}» с ценой «${plan.act.cost}» на странице`, '—'));
  }

  // friction — attached to the named object, with an attempt, a doubt or a loss.
  const object = plan.friction?.object ?? '';
  if (plan.friction === null || object.length === 0 || !mentions(text, object)) {
    found.push(finding('friction: detached', 'глава', `трение не привязано к названному предмету «${object}»`, 'привязать к предмету'));
  } else {
    found.push(finding('friction: ok', 'глава', `трение ${plan.friction.kind} при предмете «${object}»`, '—'));
  }

  // metaphor — exactly one image, zero glosses; a second explanation is quoted.
  const glosses = countGlosses(text);
  if (plan.metaphor !== null && plan.metaphor.glosses > 0) {
    found.push(finding('metaphor: glossed', 'глава', `план обещает ${String(plan.metaphor.glosses)} объяснений образа`, 'снять объяснения'));
  } else if (glosses >= 2) {
    found.push(finding('metaphor: glossed', 'глава', `образ объяснён ${String(glosses)} раза`, 'оставить одно объяснение'));
  } else if (glosses === 1) {
    found.push(finding('metaphor: second', 'глава', 'второе объяснение образа', 'снять второе'));
  } else {
    found.push(finding('metaphor: ok', 'глава', 'образ не объясняется', '—'));
  }

  // want — at stake on the page, by its own words.
  const want = plan.want.trim().split(/\s+/u)[0] ?? '';
  if (want.length === 0 || !mentions(text, plan.want)) {
    found.push(finding('want: absent', 'глава', `желание «${plan.want}» на странице не звучит`, 'поставить желание в сцену'));
  } else {
    found.push(finding('want: ok', 'глава', `желание «${plan.want}» на странице`, '—'));
  }

  // register — the turn and what earned it; a static chapter earns stillness by its payer.
  const register = plan.register_intent.trim();
  if (register.length === 0 || (!still && countGlosses(text) > 0)) {
    found.push(finding('register: unearned', 'глава', `поворот «${register}» ничем не заслужен`, 'назвать, что заслужило поворот'));
  } else {
    found.push(finding('register: ok', 'глава', `поворот «${register}» заслужен`, '—'));
  }
  return found;
}
