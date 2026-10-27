import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { donateUrlOf } from '../src/donate.ts';

/**
 * BOOK-126 — `DONATE_URL`, the one place a value reaches the page from configuration.
 *
 * The link is public (it is printed in the footer), so it is a plain variable, and it is
 * validated by an allowlist: `https` on exactly `t.tb.ru`, no port, no credentials, the path and
 * query untouched. Anything else is `null`, the footer row does not render, and — because a
 * silent typo is a typo nobody fixes — the boot says one line about the rule it applied.
 */

describe('DONATE_URL (BOOK-126)', () => {
  const GOOD = 'https://t.tb.ru/pm_short/11T50nT6AL';

  it('accepts the owner’s link unchanged and refuses every other shape', () => {
    // The good link is the link: trimmed, and nothing else touched — no normalising, no UTM,
    // no trailing-slash change.
    expect(donateUrlOf(GOOD)).toBe(GOOD);
    expect(donateUrlOf(`  ${GOOD}  `)).toBe(GOOD);
    expect(donateUrlOf(`${GOOD}?from=book`)).toBe(`${GOOD}?from=book`);

    // Four different hosts, one scheme, one script URL and two empties: all refused.
    for (const hostile of [
      'http://t.tb.ru/pm_short/11T50nT6AL',
      'https://evil.tb.ru/pm_short/11T50nT6AL',
      'https://t.tb.ru.evil.com/pm_short/11T50nT6AL',
      'https://t.tb.ru:8443/pm_short/11T50nT6AL',
      'https://user@t.tb.ru/pm_short/11T50nT6AL',
      'javascript:alert(1)',
      '//t.tb.ru/x',
      '',
      '   ',
    ]) {
      expect(donateUrlOf(hostile), hostile).toBeNull();
    }
    expect(donateUrlOf(undefined)).toBeNull();
    expect(donateUrlOf(null)).toBeNull();
  });

  it('boots without the row on an unset or hostile value, and carries the link on a good one', () => {
    expect(loadConfig({}).donateUrl).toBeNull();
    // A hostile value is not a boot failure: the row is simply off, never a dead link.
    expect(loadConfig({ DONATE_URL: 'https://evil.tb.ru/x' }).donateUrl).toBeNull();
    expect(loadConfig({ DONATE_URL: GOOD }).donateUrl).toBe(GOOD);
  });

  it('warns once when DONATE_URL was set but refused, naming the rule and not the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hostile = 'https://t.tb.ru.evil.com/pm_short/11T50nT6AL';
      expect(loadConfig({ DONATE_URL: hostile }).donateUrl).toBeNull();
      // Exactly one line, and it states the allowlist rather than echoing what was sent.
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0]?.[0] ?? '');
      expect(said).toMatch(/DONATE_URL/u);
      expect(said).toMatch(/t\.tb\.ru/u);
      expect(said).toMatch(/row is off/u);
      expect(said).not.toContain(hostile);
      expect(said).not.toContain('evil');
      expect(said).not.toContain('\n');

      // A valid link and an unset one are both silent.
      warn.mockClear();
      expect(loadConfig({ DONATE_URL: GOOD }).donateUrl).toBe(GOOD);
      expect(loadConfig({}).donateUrl).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

