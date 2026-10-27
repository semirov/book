import { describe, expect, it } from 'vitest';

import {
  RECEIPT_RIGHTS,
  RIGHTS_ASSIGNMENT,
  RIGHTS_FALLBACK,
  SUBMIT_LINE,
  TERMS_VERSION,
  receiptLine,
} from './terms.ts';

/**
 * BOOK-58 §10: the terms a reader accepts are versioned, and the version is pinned to the
 * exact words. A silent edit of a sentence — the failure the memo names as «which terms did
 * the reader accept?» — fails here, because the constant and the pinned copy must both move,
 * and the version with them.
 */
const PINNED: Record<string, { assignment: string; fallback: string; submit: string; receipt: string }> = {
  '2026-10-27.1': {
    assignment:
      'Если вариант внесён в книгу, вы отчуждаете исключительное право на него автору книги — Филиппу Семирову — в полном объёме и безвозмездно. Отправляя вариант, вы делаете это предложение; оно принимается в момент внесения, и тогда право переходит к автору. Отклонённый вариант остаётся вашим: права на него вы не передаёте. Авторство, имя и защита от искажения остаются у вас — закон не позволяет их передать. Вы разрешаете сокращать, править и переписывать свой текст в прозу книги. Факты, имена и числа авторским правом не охраняются. Вы подтверждаете, что текст ваш и не нарушает чужих прав.',
    fallback:
      'Если передача не состоится, вы даёте простую (неисключительную) лицензию на весь срок действия права, весь мир, с правом переработки.',
    submit: 'Отправляя, вы предлагаете передать исключительное право на вариант автору книги — если его внесут.',
    receipt: 'право на ваш текст перешло автору книги',
  },
};

describe('the terms a reader accepts (BOOK-58)', () => {
  it('pins the version to the exact copy: an edited sentence needs a bumped version', () => {
    const pinned = PINNED[TERMS_VERSION];
    expect(pinned, `no pinned copy for TERMS_VERSION ${TERMS_VERSION} — bump it with the text`).toBeDefined();
    expect({
      assignment: RIGHTS_ASSIGNMENT,
      fallback: RIGHTS_FALLBACK,
      submit: SUBMIT_LINE,
      receipt: RECEIPT_RIGHTS,
    }).toEqual(pinned);
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
