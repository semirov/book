import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-56 / AC2 — one fact, one reader.
 *
 * The state DTO carries `history: { live, readerChanges }`, derived on the server from
 * `changes.source_comment IS NOT NULL`. Every surface receives the boolean from the single
 * selector in `web/src/lib/historyState.ts`; no component recounts the log. The scan lives
 * under `server/test/` because the arch gate forbids `node:` imports in `web/src/`.
 */

const ROOT = join(import.meta.dirname, '../..');
const WEB_SRC = join(ROOT, 'web', 'src');
const SOURCE = /\.(ts|tsx)$/u;
const IS_TEST = /\.test\.(ts|tsx)$/u;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (SOURCE.test(name) && !IS_TEST.test(name)) out.push(path);
  }
  return out;
}

/** A doc comment naming the field is not a reader of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

/**
 * Every spelling of the read the SPA could use. A field can be reached by a member access, an
 * optional chain, a computed key or a destructuring — the scan must bite on all of them, or a
 * second reader slips past it with a `?` or a pair of brackets.
 */
const READINGS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'member', pattern: /\bstate\s*\.\s*history\b/u },
  { label: 'optional member', pattern: /\bstate\s*\?\.\s*history\b/u },
  { label: 'computed key', pattern: /\bstate\s*(?:\?\.)?\s*\[\s*['"`]history['"`]\s*\]/u },
  { label: 'destructuring', pattern: /\{[^{}\n]*\bhistory\b[^{}\n]*\}\s*=\s*[^\n;]*\bstate\b/u },
];

/** The spellings a snippet uses; empty means it never touches the field. */
function readings(text: string): string[] {
  return READINGS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

const COMPONENTS = join(WEB_SRC, 'components');

describe('the history fact has one reader in the SPA (BOOK-56)', () => {
  const files = sources(WEB_SRC).map((path) => ({
    path: relative(WEB_SRC, path),
    text: code(readFileSync(path, 'utf8')),
  }));

  it('reads `readerChanges` only in the selector', () => {
    expect(files.filter((file) => file.text.includes('readerChanges')).map((file) => file.path)).toEqual([
      'lib/historyState.ts',
    ]);
  });

  it('never reads the field outside the selector, in any spelling', () => {
    const others = files.filter((file) => file.path !== 'lib/historyState.ts');
    expect(others.flatMap((file) => readings(file.text).map((label) => `${file.path}: ${label}`))).toEqual([]);
    // The selector is the one allowed reader — and the scan does see its read, so the empty
    // list above is an exclusion, not a blind spot (`bites` proves the patterns fire).
    const selector = files.find((file) => file.path === 'lib/historyState.ts')?.text ?? '';
    expect(readings(selector)).toContain('optional member');
  });

  it('bites: every spelling is caught, and a comment or another `history` field is not', () => {
    const planted: Array<[string, string]> = [
      ['member', 'const on = state.history.live;'],
      ['optional member', 'const on = state?.history?.live;'],
      ['computed key', "const on = state['history'];"],
      ['computed key', "const on = state?.['history']?.live;"],
      ['destructuring', 'const { history } = state;'],
      ['destructuring', 'const { history: fact } = data.state ?? {};'],
    ];
    for (const [label, source] of planted) {
      expect(readings(source), `the scan must catch «${source}»`).toEqual([label]);
    }
    // The stripper keeps the scan honest in both directions: a doc comment is not a read, and
    // `change.history` (the change's own hseq span) is a different field the SPA does read.
    expect(readings(code('/** `state.history` — the one fact. */\nconst on = historyLive(state);'))).toEqual([]);
    expect(readings('const span = change.history;')).toEqual([]);
  });

  it('no gated component defaults the flag on', () => {
    // A word boundary: `let alive = true` is a local flag, not a gated prop defaulted on.
    const defaultsOn = /\b(?:live|history)\s*=\s*true/u;
    const defaults = sources(COMPONENTS)
      .map((path) => ({ path: relative(WEB_SRC, path), text: code(readFileSync(path, 'utf8')) }))
      .filter((file) => defaultsOn.test(file.text))
      .map((file) => file.path);
    expect(defaults).toEqual([]);
    // The scan bites in both directions, so the empty list above is not a blind spot.
    expect(defaultsOn.test('live = true')).toBe(true);
    expect(defaultsOn.test('history = true')).toBe(true);
    expect(defaultsOn.test('let alive = true;')).toBe(false);
  });

  it('calls the selectors once — in `App` — and passes their facts down', () => {
    expect(files.filter((file) => file.text.includes('historyLive(')).map((file) => file.path).sort()).toEqual([
      'App.tsx',
      'lib/historyState.ts',
    ]);
    expect(files.filter((file) => file.text.includes('historyStarted(')).map((file) => file.path).sort()).toEqual([
      'App.tsx',
      'lib/historyState.ts',
    ]);
    const app = files.find((file) => file.path === 'App.tsx')?.text ?? '';
    expect(app.match(/historyLive\(state\)/gu)).toHaveLength(1);
    expect(app.match(/historyStarted\(state\)/gu)).toHaveLength(1);
    // The chronicle's presence follows `started`; every history surface inside it follows
    // `live`. Both facts reach the page from this one place.
    // BOOK-128 comment #3815 — the word's record and the phrase's facts are the paragraph's own
    // margin items, not two page-root surfaces reading `live` for themselves: two surfaces that
    // took `live={history}` at the root are gone, and the paragraphs get it through the same
    // `history` prop the chapter list carries. The focus view took one more (`live={history}`)
    // and is gone with its route, so the floor is five: the cover, the chapter list, the
    // discussion, the end matter and the chronicle.
    expect(app.match(/live=\{history\}/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(app.match(/live=\{chronicle\}/gu)).toHaveLength(1);
    expect(app.match(/started=\{chronicle\}/gu)).toHaveLength(1);
    // The chronicle's own fact reaches two places: the page's view switch and the surface
    // itself. The end matter gets no `chronicle` prop — its door sat behind `live` and could
    // never open, while the switch is reachable from a begun book.
    expect(app.match(/chronicle=\{chronicle\}/gu)).toHaveLength(1);
    expect(app).toContain('history={history}');
    expect(app).toContain("view === 'chronicle' && chronicle");
  });
});
