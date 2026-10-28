/**
 * scripts/lib/icons.mjs — the icon geometry as numbers (BOOK-157), so the build can check it.
 *
 * `scripts/icons.mjs` cuts three PNGs from `cover.png`; the numbers that decide them live here,
 * because a maskable plate's only real failure is geometric and a test can assert arithmetic.
 *
 * The **safe zone** of a maskable icon is a circle of radius 40 % of the canvas (the maskable
 * spec's minimum safe zone). A square band of side `b` centred on the canvas survives every
 * square, rounded and circular mask only when its *corners* fit that circle:
 *
 *     half-diagonal = b · √2 / 2  ≤  0.4 · 512 = 204.8   ⇒   b ≤ 289.6
 *
 * So the band is 288 px, with `(512 − 288) / 2 = 112` px of the artwork's field on each side.
 * The first version of this file used 420 px (an 82 % band, 46 px of field): its corners sat
 * 296 px from the centre, 91 px inside the circle, and a circular mask clipped the painted frame
 * — the one thing a maskable plate may not do. 288 keeps the frame, the whole drawing and the
 * door post at the left edge, because the band is never cropped horizontally.
 */

/** The cover is 1024 wide and 1536 high (`web/public/cover/cover.png`). */
export const COVER_WIDTH = 1024;
export const COVER_HEIGHT = 1536;

/** The square band every icon takes: 1024 × 1024, vertically centred (y 256..1280), no crop. */
export const BAND = 1024;

/** The two `purpose: "any"` plates. */
export const ANY_SIZES = [192, 512];

/** The maskable plate's canvas and band. */
export const MASKABLE_CANVAS = 512;
export const MASKABLE_BAND = 288;
export const MASKABLE_INSET = (MASKABLE_CANVAS - MASKABLE_BAND) / 2;

/** The artwork's own field (the dark, near-black paper the drawing sits on), as `sips` reads it. */
export const FIELD = '0b0c0d';

/** The maskable spec's minimum safe radius, in pixels of the plate. */
export const SAFE_RADIUS = MASKABLE_CANVAS * 0.4;

/** The numbers a test can assert without a PNG decoder. */
export function maskableGeometry() {
  const halfDiagonal = (MASKABLE_BAND * Math.SQRT2) / 2;
  return {
    canvas: MASKABLE_CANVAS,
    band: MASKABLE_BAND,
    inset: MASKABLE_INSET,
    halfDiagonal,
    safeRadius: SAFE_RADIUS,
    /** True when the painted band, corners included, is inside the safe circle. */
    fits: halfDiagonal <= SAFE_RADIUS,
  };
}
