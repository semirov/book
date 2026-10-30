import { describe, expect, it } from 'vitest';

/**
 * No telemetry in the reader's surface, ever.
 *
 * The engine's vocabulary — stage words, durations, token counts, dollars and roubles, the
 * pass's own record page — is the author's console (`bin/admin.mjs`, `bin/engine.mjs`). This
 * guard reads the reader surfaces as source text and fails if any of it comes back. It is the
 * cheap half; the built bundle is grepped by the release gate.
 */

const surfaces = import.meta.glob<string>('./{components,lib}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Reader-facing files: the prose surfaces and the vocabulary they print. */
const READER = [
  '/components/FollowWord.tsx',
  '/components/FollowNotice.tsx',
  '/components/TrailPage.tsx',
  '/components/Chronicle.tsx',
  '/components/Discussion.tsx',
  '/components/FootJumps.tsx',
  '/components/Record.tsx',
  '/components/RecordParts.tsx',
  '/components/RecordRow.tsx',
  '/components/ChapterProse.tsx',
  '/components/ChangeSection.tsx',
  '/components/MomentControl.tsx',
  '/components/Colophon.tsx',
  '/components/HeadLine.tsx',
  '/lib/changeView.ts',
  '/lib/grip.ts',
  '/lib/recState.ts',
  '/lib/history.ts',
  '/lib/nowState.ts',
];

/**
 * The file's **printed** text: its comments are not copy, so a doc comment that quotes the
 * author's line («впереди 2 · 0,05 $») is not a price on the page. Strings are untouched.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

function source(path: string): string {
  const entry = Object.entries(surfaces).find(([file]) => file.endsWith(path));
  if (entry === undefined) throw new Error(`the reader surface ${path} is not in the glob`);
  return entry[1];
}

/**
 * The stage vocabulary **as the record printed it**: the verb and its colon (`внёс:`). The bare
 * verb is the reader's own language — «машина внесла правку», «машина пишет главу» — and the
 * owner asked for it; the colon is what made a word a stage label, so that is what is forbidden.
 */
const STAGES = ['ждал:', 'читал:', 'писал:', 'сверял:', 'внёс:'];

/** A stage label in this text: the colon form only, never the human verb. */
function stageHit(text: string): boolean {
  return STAGES.some((stage) => text.includes(stage));
}

/**
 * A price in this text: a two-decimal amount before `$`, a rouble sign, or the cost fields.
 * `'$'` on its own is not the pattern — `${…}` is a template literal, not money.
 */
const MONEY = [/\d[\d\s]*[.,]\d{2}\s*\$/u, /₽/u, /costUsd|usdText|\bUSD\b/u];

function moneyHit(text: string): boolean {
  return MONEY.some((pattern) => pattern.test(text));
}

describe('the reader’s surfaces carry no engine telemetry', () => {
  it('prints no token count, money, stage word or duration', () => {
    for (const path of READER) {
      const text = code(source(path));
      expect(text, `${path} must not name tokens`).not.toContain('токен');
      expect(moneyHit(text), `${path} must not price anything`).toBe(false);
      expect(stageHit(text), `${path} must not carry a stage label`).toBe(false);
      for (const duration of ['минут', 'минуты', 'секунд', 'секунды']) {
        expect(text, `${path}: ${duration}`).not.toContain(duration);
      }
      // The reader's sentence is a state, never a gate's verdict word.
      expect(text, `${path} must not carry a gate word`).not.toContain('не принято');
    }
  });

  it('its two rules can fail: «внёс:» is machinery, «машина внесла правку» is the reader’s', () => {
    // The guard's positive side: a synthetic line with the label is a hit…
    expect(stageHit('28.10, 00:29 · внёс: правка')).toBe(true);
    expect(stageHit('писал: глава 12')).toBe(true);
    expect(stageHit('сверял: ответ')).toBe(true);
    // …while the owner's own sentences are not, and neither is a template literal a price.
    expect(stageHit('машина внесла правку 28.10, 00:29')).toBe(false);
    expect(stageHit('никто не внёс правку')).toBe(false);
    expect(stageHit('машина пишет главу')).toBe(false);
    expect(moneyHit('0,05 $')).toBe(true);
    expect(moneyHit('≈ 0,12 $')).toBe(true);
    expect(moneyHit('0,05 ₽')).toBe(true);
    expect(moneyHit('${cost}')).toBe(false);
    // And every reader surface is scanned by those same two functions.
    for (const path of READER) {
      expect(stageHit(code(source(path))), `${path} must not carry a stage label`).toBe(false);
      expect(moneyHit(code(source(path))), `${path} must not price anything`).toBe(false);
    }
  });

  it('prices only the author’s line, and only through the shared money word', () => {
    const head = code(source('/components/HeadLine.tsx'));
    const now = code(source('/lib/nowState.ts'));
    // No reader surface spells a price, and the head spells no amount of its own: the string is
    // `stateWords.moneyWord`'s, built in the head's own model…
    expect(moneyHit(head)).toBe(false);
    expect(now).toContain('moneyWord(');
    expect(moneyHit(now)).toBe(false);
    // …and drawn only in the author block, which exists only for `viewer.isAuthor`.
    expect(head).toContain('head-line-author');
    expect(head).toContain('state.author');
    expect(now).toContain("state.viewer.isAuthor !== true");
  });

  it('has no reader route to the operator’s pass record', () => {
    for (const path of READER) expect(source(path), path).not.toContain('PassRecordPage');
  });

  it('keeps the failure strings of the reader surfaces', () => {
    expect(source('/components/TrailPage.tsx')).toContain('след не прочитался');
    expect(source('/components/Discussion.tsx')).toContain('не удалось прочитать обсуждение');
    expect(source('/components/MomentControl.tsx')).toContain('показаны');
  });
});
