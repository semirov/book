import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The cover plate's asset guard (BOOK-131).
 *
 * The class of defect this catches: an `srcset` descriptor that lies about its file. The browser
 * trusts the `w` number, picks the candidate for a slot it cannot fill and upscales it silently —
 * `cover-640.jpg` is 426 × 640 (the name counts its *height*), so a `640w` descriptor would have
 * every browser plan for 640 px from a 426 px file: 1.5× by the descriptor, 1.6× in the paint. No
 * other gate compares the two: the component test can only read the string it was handed, and a
 * browser shows the result, it does not report it.
 *
 * The assets live in `web/public/cover/` and are read as bytes here — the house's home for tests
 * that read repository files, next to `copy.test.ts` — and the numbers the component reserves on
 * the `<img>` (`width`/`height`) are checked against them too, so the box the page holds open can
 * never describe a different picture from the one the browser paints. The `src` fallback is held
 * to the same set: a typo there is the one path a `srcset`-aware browser never exercises.
 */

const ROOT = join(import.meta.dirname, '../..');
/** The sheet that declares the plate: the `srcSet` constant and the `<img>` it feeds, one file. */
const SHEET = 'web/src/components/TitleSheet.tsx';
/** Where Vite serves the cover from: the markup's `/cover/…` paths live under here. */
const PUBLIC = join(ROOT, 'web/public');

/** A JPEG's true pixel size, read from its frame header: the first SOF in the segment chain. */
function jpegSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  let at = 2; // past SOI (0xFFD8)
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    // SOF0–SOF15 carry the frame's height and width; DHT (C4), JPG (C8) and DAC (CC) share the
    // range but carry no frame.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    // Stand-alone markers carry no length: SOI, TEM and the RSTn family.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  throw new Error(`${path}: no SOF segment — not a baseline JPEG`);
}

/** The `<img className="cover-plate">` element as written, so the prop names come from the code. */
function plateElement(source: string): string {
  const match = source.match(/<img\s+className="cover-plate"[\s\S]*?\/>/u);
  if (match?.[0] === undefined) throw new Error(`${SHEET}: no <img className="cover-plate">`);
  return match[0];
}

/** The value of a module constant that is a string: `const NAME = '…';`. */
function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*'([^']+)';`, 'u'));
  if (match?.[1] === undefined) throw new Error(`${SHEET}: no string constant ${name}`);
  return match[1];
}

/** One `srcset` candidate: the served path and the width descriptor, without the `w`. */
type Candidate = { path: string; declared: number };

function candidatesOf(srcSet: string): Candidate[] {
  return srcSet
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [path = '', descriptor = ''] = entry.split(/\s+/u);
      expect(descriptor, `${path || entry}: a srcset candidate declares a width`).toMatch(/^\d+w$/u);
      return { path, declared: Number.parseInt(descriptor, 10) };
    });
}

const source = readFileSync(join(ROOT, SHEET), 'utf8');
const element = plateElement(source);

describe('the cover plate declares the asset it paints (BOOK-131)', () => {
  it('gives every candidate the width its file really has, and keeps all of them 2:3', () => {
    const srcSetName = element.match(/srcSet=\{(\w+)\}/u)?.[1];
    expect(srcSetName, 'the plate binds no srcSet constant').toBeDefined();
    const candidates = candidatesOf(constant(source, srcSetName ?? ''));
    expect(candidates.length).toBeGreaterThan(1);

    for (const { path, declared } of candidates) {
      const { width, height } = jpegSize(join(PUBLIC, path));
      // The failure this test exists for: «cover-640.jpg declares 640w, but the file is 426 × 640».
      expect(declared, `${basename(path)} declares ${declared}w, but the file is ${width} × ${height}`).toBe(width);
      // 426 of 640 is 2:3 to the pixel it can hold; the PNG original is 1 024 × 1 536 exactly.
      expect(Math.abs(width - (height * 2) / 3), `${basename(path)} is ${width} × ${height}, not 2:3`).toBeLessThanOrEqual(1);
    }
  });

  it('reserves the box of its largest candidate, so the layout holds the picture it paints', () => {
    const srcSetName = element.match(/srcSet=\{(\w+)\}/u)?.[1] ?? '';
    const candidates = candidatesOf(constant(source, srcSetName));
    const measured = candidates
      .map(({ path }) => ({ path, ...jpegSize(join(PUBLIC, path)) }))
      .sort((left, right) => right.width - left.width);
    const largest = measured[0];
    if (largest === undefined) throw new Error(`${SHEET}: the plate has no srcset candidate`);

    // The intrinsic size is what CLS and the paint agree on: a box of another ratio would letterbox
    // the plate or leave the page's own arithmetic describing a picture that is not there.
    const width = element.match(/width=\{(\d+)\}/u)?.[1] ?? '';
    const height = element.match(/height=\{(\d+)\}/u)?.[1] ?? '';
    expect(Number(width), `the plate reserves width ${width}, its largest file is ${largest.width} px wide`).toBe(largest.width);
    expect(Number(height), `the plate reserves height ${height}, its largest file is ${largest.height} px tall`).toBe(largest.height);

    // The no-srcset fallback is the one path a `srcset`-aware browser never takes, so a typo in it
    // would ship unseen: it must resolve to one of the candidates the sheet already declares.
    const srcName = element.match(/\ssrc=\{(\w+)\}/u)?.[1] ?? '';
    expect(srcName, 'the plate binds no src constant').not.toBe('');
    const fallback = constant(source, srcName);
    expect(candidates.map(({ path }) => path), `the plate's src is «${fallback}», not one of its srcset candidates`).toContain(fallback);
  });
});
