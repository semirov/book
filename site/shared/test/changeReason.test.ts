import { describe, expect, it } from 'vitest';

import { attemptOfLine, queueAttemptsLine } from '../src/attempt.ts';
import { holdsInternalCode, readerReason } from '../src/change.ts';
import { ATTEMPT_LINE, FAILED_ATTEMPT_LINE, STOP_REASONS, TRIAGE_REFUSED_LINE } from '../src/stateWords.ts';

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
    expect(readerReason('модель не ответила: PROVIDER_SHAPE')).toBe(STOP_REASONS.shape);
    // BOOK-218 owns the sentence a stored code becomes: it is our failure, and it is retryable.
    expect(STOP_REASONS.shape).toMatch(/^не дошло: /u);
    // A filed attempt's own line is a different fact from a stop: it is the attempt that failed.
    expect(FAILED_ATTEMPT_LINE.length).toBeGreaterThan(0);
    expect(FAILED_ATTEMPT_LINE).not.toMatch(/в очереди|исчерпа/iu);
  });

  it('names the engine’s silence, in either spelling', () => {
    expect(readerReason('движок отказал: ENGINE_TIMEOUT: the engine did not answer within 10000 ms')).toBe(
      STOP_REASONS.engineDown,
    );
    // The word alone, with no code, is a sentence the row already carries — it is not rewritten.
    expect(readerReason('timeout: 10 s')).toBe('timeout: 10 s');
    // A timeout behind a code is the machine being slow, not the engine being gone.
    expect(readerReason('провайдер: TIMEOUT_LIMIT (timeout 10000 ms)')).toBe(STOP_REASONS.modelTimeout);
    expect(STOP_REASONS.engineDown).toMatch(/^не дошло: /u);
    expect(STOP_REASONS.engineDown).toContain('нажмите «повторить»');
  });

  it('falls back to one plain line for any other code, and never lets a code through', () => {
    expect(readerReason('движок отказал: PROVIDER_ONLY_CODE')).toBe(ATTEMPT_LINE);
    expect(ATTEMPT_LINE).not.toBe(FAILED_ATTEMPT_LINE);
    expect(ATTEMPT_LINE).not.toMatch(/в очереди|исчерпа/iu);
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
    expect(readerReason('модель: provider_shape')).toBe(STOP_REASONS.shape);
    expect(readerReason('движок: engine_timeout')).toBe(STOP_REASONS.engineDown);
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

/**
 * The owner's correction (2026-10-29): «нет, сроков не надо — только конечное количество
 * попыток». A record may show a count; a sentence may never promise a wait.
 */
describe('an attempt is a count, never a wait', () => {
  it('names a filing’s place in the count, and the queue’s end in the same words', () => {
    expect(attemptOfLine(4)).toBe('попытка 4 из 6');
    expect(attemptOfLine(6, 6)).toBe('попытка 6 из 6');
    expect(queueAttemptsLine()).toBe('заявка не дошла до главы за 6 попыток');
    expect(queueAttemptsLine(3)).toBe('заявка не дошла до главы за 3 попыток');
    for (const line of [attemptOfLine(2), queueAttemptsLine(), TRIAGE_REFUSED_LINE]) {
      expect(line).not.toMatch(/ждёт|в очереди|исчерпа|час|минут/iu);
    }
  });
});
