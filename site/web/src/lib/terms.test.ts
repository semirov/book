import { describe, expect, it } from 'vitest';

import {
  MACHINE_TOOL_CAVEAT,
  MACHINE_TOOL_RULES,
  RECEIPT_RIGHTS,
  RIGHTS_ASSIGNMENT,
  RIGHTS_FALLBACK,
  RIGHTS_RETAINED,
  SUBMIT_LINE,
  TERMS_VERSION,
  TOOL_CLAUSE,
  receiptLine,
} from './terms.ts';

/** Every reader-visible string one version of the terms carried. */
type TermsCopy = {
  assignment: string;
  fallback: string;
  submit: string;
  receipt: string;
  tool: string;
  retained: readonly string[];
  machineRules: string;
  machineCaveat: string;
};

const words = (text: string): number => text.split(/\s+/u).filter((word) => word.length > 0).length;

/**
 * BOOK-58 §10: the terms a reader accepts are versioned, and the version is pinned to the
 * exact words. A silent edit of a sentence — the failure the memo names as «which terms did
 * the reader accept?» — fails here, because the constant and the pinned copy must both move,
 * and the version with them.
 *
 * The record is history, not a config: each row says what the readers of that version
 * accepted, so an old row is never rewritten. BOOK-72/BOOK-69 added the tool clause, the
 * retained list and the «Кто пишет книгу» pair as a new version, and the old row keeps the
 * four strings it always had.
 */
const PINNED: Record<string, Partial<TermsCopy>> = {
  '2026-10-27.1': {
    assignment:
      'Если вариант внесён в книгу, вы отчуждаете исключительное право на него автору книги — Филиппу Семирову — в полном объёме и безвозмездно. Отправляя вариант, вы делаете это предложение; оно принимается в момент внесения, и тогда право переходит к автору. Отклонённый вариант остаётся вашим: права на него вы не передаёте. Авторство, имя и защита от искажения остаются у вас — закон не позволяет их передать. Вы разрешаете сокращать, править и переписывать свой текст в прозу книги. Факты, имена и числа авторским правом не охраняются. Вы подтверждаете, что текст ваш и не нарушает чужих прав.',
    fallback:
      'Если передача не состоится, вы даёте простую (неисключительную) лицензию на весь срок действия права, весь мир, с правом переработки.',
    submit: 'Отправляя, вы предлагаете передать исключительное право на вариант автору книги — если его внесут.',
    receipt: 'право на ваш текст перешло автору книги',
  },
  '2026-10-28.1': {
    assignment:
      'Если вариант внесён в книгу, вы отчуждаете исключительное право на него автору книги — Филиппу Семирову — в полном объёме и безвозмездно. Отправляя вариант, вы делаете это предложение; оно принимается в момент внесения, и тогда право переходит к автору. Отклонённый вариант остаётся вашим: права на него вы не передаёте. Авторство, имя и защита от искажения остаются у вас — закон не позволяет их передать. Вы разрешаете сокращать, править и переписывать свой текст в прозу книги. Факты, имена и числа авторским правом не охраняются. Вы подтверждаете, что текст ваш и не нарушает чужих прав.',
    fallback:
      'Если передача не состоится, вы даёте простую (неисключительную) лицензию на весь срок действия права, весь мир, с правом переработки.',
    submit: 'Отправляя, вы предлагаете передать исключительное право на вариант автору книги — если его внесут.',
    receipt: 'право на ваш текст перешло автору книги',
    tool: 'Машина — инструмент, не автор и не правообладатель: авторские права возникают только у людей — и передаются человеку, автору книги.',
    retained: [
      'Авторство и имя остаются вашими — закон не позволяет их передать. Остаётся и защита от искажения, которое вас порочит.',
      'Отклонённый вариант остаётся вашим целиком: на него ничего не передано.',
      'Замечание без типа ничего не передаёт — это не вмешательство.',
      'Скрыть себя из списка авторов меняет только показ: права и ваша доля остаются.',
    ],
    machineRules:
      'Книгу пишет человек. Машина — инструмент: она читает вмешательство, проверяет, укладывается ли оно в книгу, и набрасывает прозу по заданию автора. Автор — Филипп Семиров: канон, замысел и решения его. У машины нет авторства и нет прав — ни у неё, ни у её разработчика: по закону автором может быть только человек. Поэтому в списке авторов и в выходных данных стоят люди, а не программа.',
    machineCaveat:
      'Право здесь не устоялось: текст, целиком написанный машиной без творческого вклада человека, может не охраняться вовсе — поэтому книга держится на каноне, задании и решениях автора, а не на машине.',
  },
};

const current = (): TermsCopy => ({
  assignment: RIGHTS_ASSIGNMENT,
  fallback: RIGHTS_FALLBACK,
  submit: SUBMIT_LINE,
  receipt: RECEIPT_RIGHTS,
  tool: TOOL_CLAUSE,
  retained: RIGHTS_RETAINED,
  machineRules: MACHINE_TOOL_RULES,
  machineCaveat: MACHINE_TOOL_CAVEAT,
});

describe('the terms a reader accepts (BOOK-58)', () => {
  it('pins the version to the exact copy: an edited sentence needs a bumped version', () => {
    const pinned = PINNED[TERMS_VERSION];
    expect(pinned, `no pinned copy for TERMS_VERSION ${TERMS_VERSION} — bump it with the text`).toBeDefined();
    expect(current()).toEqual(pinned);
  });

  it('keeps the record as appended history, so an old row cannot follow the new text', () => {
    const versions = Object.keys(PINNED);
    // The current version is the last row: a new one is appended, never squeezed in place of
    // an old one, and the row a reader accepted is never rewritten to match today's words.
    expect(versions.at(-1)).toBe(TERMS_VERSION);
    expect(versions).toEqual([...versions].sort());
    expect(versions.length).toBeGreaterThan(1);
    // The previous row still holds only the four strings it was accepted with.
    const previous = PINNED['2026-10-27.1'] ?? {};
    expect(Object.keys(previous).sort()).toEqual(['assignment', 'fallback', 'receipt', 'submit']);
  });

  it('states the assignment, not a licence, and never promises authorship', () => {
    // The old promise was «неисключительная лицензия»; BOOK-58 makes the right pass in full.
    expect(RIGHTS_ASSIGNMENT).toContain('отчуждаете исключительное право');
    expect(RIGHTS_ASSIGNMENT).toContain('безвозмездно');
    expect(RIGHTS_ASSIGNMENT).toContain('Авторство, имя и защита от искажения остаются у вас');
    expect(RIGHTS_ASSIGNMENT).not.toContain('неисключительную');
    // A rejected variant stays the reader's: nothing transferred, nothing to promise away.
    expect(RIGHTS_ASSIGNMENT).toContain('Отклонённый вариант остаётся вашим');
    // The fallback is the one sentence that saves the worst case (§7a).
    expect(RIGHTS_FALLBACK).toContain('простую (неисключительную) лицензию');
    expect(RIGHTS_FALLBACK).toContain('с правом переработки');
  });

  it('prints the receipt with the chapter it was entered into', () => {
    expect(receiptLine('07')).toBe('внесено в главу 07 · право на ваш текст перешло автору книги');
    // The phrase carries its own noun and claims no day, no wave and no audit.
    expect(RECEIPT_RIGHTS).not.toMatch(/волн|аудит|сегодня/u);
  });
});

describe('the tool clause and the retained list (BOOK-72, BOOK-69)', () => {
  it('names the machine as a tool, never as an author or a rights holder', () => {
    expect(TOOL_CLAUSE).toContain('не автор и не правообладатель');
    // Rights arise only in people, and pass to the book's author — the clause in one breath.
    expect(TOOL_CLAUSE).toContain('возникают только у людей');
    expect(TOOL_CLAUSE).toContain('передаются человеку, автору книги');
    // The versioned copy may not quietly claim the opposite anywhere in this clause.
    expect(TOOL_CLAUSE).not.toMatch(/(?:явля\w*|становится) (?:со)?автором/u);
  });

  it('lists exactly four things that stay, one for each promise', () => {
    expect(RIGHTS_RETAINED).toHaveLength(4);
    for (const line of RIGHTS_RETAINED) expect(line.trim().length).toBeGreaterThan(0);
    // Authorship and the name cannot pass; the protection from distortion stays with them.
    expect(RIGHTS_RETAINED[0]).toContain('Авторство и имя остаются вашими');
    expect(RIGHTS_RETAINED[0]).toContain('защита от искажения');
    // A rejected variant stays whole: nothing was transferred on it.
    expect(RIGHTS_RETAINED[1]).toContain('Отклонённый вариант остаётся вашим целиком');
    // A note without a type gives nothing away.
    expect(RIGHTS_RETAINED[2]).toContain('Замечание без типа ничего не передаёт');
    // Hiding the name changes the show, not the right or the share.
    expect(RIGHTS_RETAINED[3]).toContain('Скрыть себя из списка авторов меняет только показ');
    expect(RIGHTS_RETAINED[3]).toContain('права и ваша доля остаются');
  });

  it('keeps the retained list short enough to be read as a list', () => {
    // A ceiling, not a count: the copy may be shortened, never grown past a screenful.
    expect(words(RIGHTS_RETAINED.join(' '))).toBeLessThanOrEqual(85);
  });

  it('names the author, the machine and the missing right in «Кто пишет книгу»', () => {
    expect(words(MACHINE_TOOL_RULES)).toBeLessThanOrEqual(80);
    expect(MACHINE_TOOL_RULES).toContain('Книгу пишет человек');
    expect(MACHINE_TOOL_RULES).toContain('Машина — инструмент');
    expect(MACHINE_TOOL_RULES).toContain('Автор — Филипп Семиров');
    // No authorship and no rights — neither for the tool nor for the people who built it.
    expect(MACHINE_TOOL_RULES).toContain('нет авторства и нет прав');
    expect(MACHINE_TOOL_RULES).toContain('ни у её разработчика');
    expect(MACHINE_TOOL_RULES).toContain('автором может быть только человек');
    // The clause and the section agree: both refuse the claim in the same words.
    expect(MACHINE_TOOL_RULES).toContain('не программа');
  });

  it('says the law has not settled for a wholly machine-written text', () => {
    expect(MACHINE_TOOL_CAVEAT).toContain('может не охраняться вовсе');
    // And keeps the book on the author's decisions, not on the tool.
    expect(MACHINE_TOOL_CAVEAT).toContain('на каноне, задании и решениях автора');
  });
});
