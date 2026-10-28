import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_LINE,
  ENGINE_SILENT_LINE,
  FAILED_ATTEMPT_LINE,
  holdsInternalCode,
  readerReason,
} from '../src/change.ts';

/**
 * A public reason is a sentence a reader may read.
 *
 * The engine's failures are stored as handle-plus-code («модель не ответила: PROVIDER_SHAPE»,
 * «движок отказал: ENGINE_TIMEOUT: …»), and a code is an operator's handle, not copy: every
 * surface — the thread, the change card, the reader's own record, the chronicle — reads the
 * one sentence this module returns, so no code can survive in two of them and not the others.
 */
describe('readerReason', () => {
  it('keeps a human sentence exactly as written', () => {
    expect(readerReason('принято: глава 65 отвечает на вопрос процедурой')).toBe(
      'принято: глава 65 отвечает на вопрос процедурой',
    );
    expect(readerReason('  не   беру:   документ не из этой сцены ')).toBe('не беру: документ не из этой сцены');
  });

  it('answers nothing when there is nothing to answer', () => {
    expect(readerReason(null)).toBeNull();
    expect(readerReason(undefined)).toBeNull();
    expect(readerReason('   ')).toBeNull();
    expect(readerReason(42)).toBeNull();
  });

  it('replaces an off-shape model answer with the deck’s line', () => {
    expect(readerReason('модель не ответила: PROVIDER_SHAPE')).toBe(FAILED_ATTEMPT_LINE);
    expect(FAILED_ATTEMPT_LINE).toBe('модель ответила не по форме — заявка остаётся в очереди');
  });

  it('names the engine’s silence, in either spelling', () => {
    expect(readerReason('движок отказал: ENGINE_TIMEOUT: the engine did not answer within 10000 ms')).toBe(
      ENGINE_SILENT_LINE,
    );
    // The word alone, with no code, is a sentence the row already carries — it is not rewritten.
    expect(readerReason('timeout: 10 s')).toBe('timeout: 10 s');
    expect(readerReason('провайдер: TIMEOUT_LIMIT (timeout 10000 ms)')).toBe(ENGINE_SILENT_LINE);
    expect(ENGINE_SILENT_LINE).toBe('движок не ответил — попытка не завершилась');
  });

  it('falls back to one plain line for any other code, and never lets a code through', () => {
    expect(readerReason('движок отказал: PROVIDER_ONLY_CODE')).toBe(ATTEMPT_LINE);
    expect(ATTEMPT_LINE).toBe('попытка не удалась — заявка остаётся в очереди');
    const raw = ['модель не ответила: PROVIDER_SHAPE', 'движок: ENGINE_TIMEOUT', 'стоп: GATE_ABORT_X'];
    for (const line of raw) expect(readerReason(line) ?? '').not.toMatch(/[A-Z]{2,}_[A-Z]/u);
  });

  it('recognises an internal code by shape, and a lowercase handle by its known name', () => {
    expect(holdsInternalCode('PROVIDER_SHAPE')).toBe(true);
    expect(holdsInternalCode('модель не ответила: PROVIDER_SHAPE')).toBe(true);
    // The engine stores its handles in both registers; the lowercase snake spelling is still a
    // code, and it never reaches the reader either.
    expect(holdsInternalCode('provider_shape')).toBe(true);
    expect(holdsInternalCode('движок: engine_timeout')).toBe(true);
    expect(readerReason('модель: provider_shape')).toBe(FAILED_ATTEMPT_LINE);
    expect(readerReason('движок: engine_timeout')).toBe(ENGINE_SILENT_LINE);
    // A sentence with capitals and no underscore is a sentence; a lowercase word is not a code.
    expect(holdsInternalCode('глава 65 не готова')).toBe(false);
    expect(holdsInternalCode('Gate-Timeout')).toBe(false);
    expect(holdsInternalCode('глава 65 уже написана')).toBe(false);
    expect(holdsInternalCode(null)).toBe(false);
  });

  it('keeps a human reason that happens to hold an underscore word', () => {
    // BOOK-158 review m3: only the known handles are codes. A writer's own sentence about an
    // accepted decision must reach the reader verbatim, underscore and all.
    const human = 'принято: имя west_wing остаётся как есть — это название корабля';
    expect(holdsInternalCode(human)).toBe(false);
    expect(readerReason(human)).toBe(human);
    // Another snake word is not a code either — the list is the engine's handles, not a shape.
    expect(holdsInternalCode('правка прошла: second_pass')).toBe(false);
  });
});
