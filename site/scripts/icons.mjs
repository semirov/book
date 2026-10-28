#!/usr/bin/env node
/**
 * scripts/icons.mjs — BOOK-157: the three home-screen icons, cut from the cover (BOOK-131's art).
 *
 * A maintainer script, not a step of the gate: the PNGs it writes are committed, so a build box
 * without `sips` (a Linux container, CI) still ships them. Run it only when `cover.png` changes:
 *
 *   node scripts/icons.mjs
 *
 * The band is the part of the 1536-high cover a square icon can show: 1024 x 1024, vertically
 * centred (y 256..1280). **No horizontal crop** — the cover is exactly 1024 wide, so the door
 * post stays at the left edge and the figures at the right one, which is how the drawing reads
 * at 64 px: the lamp and the lit sheet, with the room's two walls around them.
 *
 *   icon-192.png / icon-512.png  the band, `purpose: any`. The launcher draws these as they are.
 *   maskable-512.png             the band at 288 px on a 512 canvas filled with the artwork's own
 *                                field #0b0c0d: 112 px of field on every side, and the band's
 *                                corners (203.7 px from the centre) inside the maskable safe
 *                                circle (40 % of 512 = 204.8 px). A circular or rounded mask
 *                                therefore never touches the drawing or its frame. The numbers
 *                                are `scripts/lib/icons.mjs`'s, and a test asserts the geometry.
 *
 * No lossy intermediate and no new dependency: `sips` reads the PNG and writes PNG. It is
 * deterministic — same input, same bytes — so a re-run is a no-op in git.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANY_SIZES, BAND, FIELD, MASKABLE_BAND, MASKABLE_CANVAS, maskableGeometry } from './lib/icons.mjs';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COVER = join(SITE, 'web', 'public', 'cover', 'cover.png');
const OUT = join(SITE, 'web', 'public', 'icons');

function sips(...args) {
  execFileSync('sips', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function size(file) {
  const width = execFileSync('sips', ['-g', 'pixelWidth', file], { encoding: 'utf8' }).trim().split(': ')[1];
  const height = execFileSync('sips', ['-g', 'pixelHeight', file], { encoding: 'utf8' }).trim().split(': ')[1];
  return `${String(width)}x${String(height)}`;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'book-icons-'));
  try {
    const band = join(work, 'band.png');
    copyFileSync(COVER, band);
    // A centre crop keeps the band's own middle column: 1024 of the 1536 rows, y 256..1280.
    sips('-c', String(BAND), String(BAND), band);

    for (const px of ANY_SIZES) {
      const name = `icon-${String(px)}.png`;
      const out = join(OUT, name);
      sips('-z', String(px), String(px), band, '--out', out);
      console.log(`icons: ${name} ${size(out)}`);
    }

    const maskable = join(work, 'maskable.png');
    copyFileSync(band, maskable);
    sips('-z', String(MASKABLE_BAND), String(MASKABLE_BAND), maskable);
    // `-p` pads to the canvas, centring the image; the fill is the field the drawing sits on.
    sips('-p', String(MASKABLE_CANVAS), String(MASKABLE_CANVAS), '--padColor', FIELD, maskable);
    const maskableOut = join(OUT, 'maskable-512.png');
    copyFileSync(maskable, maskableOut);
    const geometry = maskableGeometry();
    console.log(
      `icons: maskable-512.png ${size(maskableOut)} (band ${String(geometry.band)} px, inset ${String(geometry.inset)} px, ` +
        `half-diagonal ${geometry.halfDiagonal.toFixed(1)} of ${String(geometry.safeRadius)} safe radius, field #${FIELD})`,
    );
    if (!geometry.fits) {
      // The one geometry a maskable plate may not break: a mask would cut the drawing's frame.
      throw new Error(`the maskable band ${String(geometry.band)} px is outside the safe circle`);
    }

    for (const name of ['icon-192.png', 'icon-512.png', 'maskable-512.png']) {
      const bytes = statSync(join(OUT, name)).size;
      console.log(`icons:   ${name} ${String(bytes)} bytes`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`icons: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
