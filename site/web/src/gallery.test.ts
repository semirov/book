import { describe, expect, it } from 'vitest';

/**
 * BOOK-128 comment #3900 §1 — the gallery is the gate's evidence, so it may not lose a row.
 *
 * `scripts/line-fonts-cdp.mjs` fails closed at run time (exit 2) when a section the manifest
 * names is missing from the rendered page. This is the same invariant held without a browser:
 * the manifest and the gallery's own `<Line id>` list must be the same set, in both directions —
 * an audited line with no section would go unmeasured, and a section nobody audits would add
 * lines the report cannot explain.
 *
 * Both files are read as text (`?raw`): the SPA never imports Node built-ins, and the point is
 * the source's own section list, not a render.
 *
 * Coverage only: no expected measurement is written here or in the manifest.
 */

const sources = import.meta.glob<string>('../harness/lines.{tsx,manifest.json}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function source(name: '../harness/lines.tsx' | '../harness/lines.manifest.json'): string {
  const text = sources[name];
  if (text === undefined) throw new Error(`the gallery source ${name} is not in the glob`);
  return text;
}

describe('the one-line gallery covers every audited line', () => {
  it('names the same selectors as its manifest', () => {
    const sections = [...source('../harness/lines.tsx').matchAll(/<Line id="([^"]+)"/gu)].map(
      (match) => match[1] ?? '',
    );
    const manifest = JSON.parse(source('../harness/lines.manifest.json')) as { lines: string[] };
    // A shrunken gallery is the failure this test exists for: keep the floor explicit.
    expect(manifest.lines.length).toBeGreaterThanOrEqual(30);
    expect(manifest.lines.filter((id) => !sections.includes(id))).toEqual([]);
    expect(sections.filter((id) => !manifest.lines.includes(id))).toEqual([]);
  });
});
