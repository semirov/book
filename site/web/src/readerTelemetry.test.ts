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

function source(path: string): string {
  const entry = Object.entries(surfaces).find(([file]) => file.endsWith(path));
  if (entry === undefined) throw new Error(`the reader surface ${path} is not in the glob`);
  return entry[1];
}

/** A whole word, not a substring: `писалась` is a state word, `писал` is a stage. */
function word(text: string, needle: string): boolean {
  return new RegExp(`(^|[^\\p{L}])${needle}([^\\p{L}]|$)`, 'u').test(text);
}

const STAGES = ['ждал', 'читал', 'писал', 'сверял', 'внёс'];

describe('the reader’s surfaces carry no engine telemetry', () => {
  it('prints no token count, money, stage word or duration', () => {
    for (const path of READER) {
      const text = source(path);
      expect(text, `${path} must not name tokens`).not.toContain('токен');
      expect(text, `${path} must not price anything`).not.toContain('₽');
      expect(text, `${path} must not price anything`).not.toMatch(/costUsd|usdText|USD/u);
      for (const stage of STAGES) expect(word(text, stage), `${path}: ${stage}`).toBe(false);
      for (const duration of ['минут', 'минуты', 'секунд', 'секунды']) {
        expect(text, `${path}: ${duration}`).not.toContain(duration);
      }
      // The reader's sentence is a state, never a gate's verdict word.
      expect(text, `${path} must not carry a gate word`).not.toContain('не принято');
    }
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
