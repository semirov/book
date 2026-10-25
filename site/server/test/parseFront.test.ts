import { describe, expect, it } from 'vitest';

import { parseFront } from '../src/ingest/parseFront.ts';

const ABOUT =
  'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
  'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: её ' +
  'обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают само, ' +
  'без человека. Конец у этой книги один, и он не спрятан: шестьдесят семь глав пишутся в открытую.';

describe('parseFront', () => {
  it('reads the live title and page 2', () => {
    const parsed = parseFront(`Земля, которая больше не кормит\n\n${ABOUT}\n`);
    expect(parsed.title).toBe('Земля, которая больше не кормит');
    expect(parsed.about).toBe(ABOUT);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.chars).toBe(ABOUT.length);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('normalizes CRLF before hashing and keeps the snapshot text normalized', () => {
    const parsed = parseFront(`Земля\r\n\r\n${ABOUT}\r\n`);
    expect(parsed.text).not.toContain('\r');
    expect(parsed.title).toBe('Земля');
    expect(parsed.about).toBe(ABOUT);
  });

  it('keeps page 2 as blocks separated by a blank line', () => {
    const half = ABOUT.slice(0, Math.floor(ABOUT.length / 2));
    const secondHalf = ABOUT.slice(Math.floor(ABOUT.length / 2));
    const parsed = parseFront(`Земля\n\n${half}\n\n${secondHalf}`);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.about).toBe(`${half}\n\n${secondHalf}`);
  });

  it('nulls page 2 when the annotation is malformed, keeping the title', () => {
    const parsed = parseFront('Земля\n\nСлишком коротко.');
    expect(parsed.title).toBe('Земля');
    expect(parsed.about).toBeNull();
    expect(parsed.problems.join(' ')).toContain('expected 300–900');
  });

  it('nulls the title when line 1 is malformed', () => {
    const parsed = parseFront(`${'я'.repeat(81)}\n\n${ABOUT}`);
    expect(parsed.title).toBeNull();
    expect(parsed.about).toBe(ABOUT);
  });
});
