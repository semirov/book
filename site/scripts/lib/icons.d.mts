/**
 * Types for `scripts/lib/icons.mjs` (BOOK-157) — the icon geometry `scripts/icons.mjs` cuts with
 * and `server/test/pwa.test.ts` asserts. Only the surface those two use is declared.
 */

export type MaskableGeometry = {
  canvas: number;
  band: number;
  inset: number;
  halfDiagonal: number;
  safeRadius: number;
  fits: boolean;
};

export const COVER_WIDTH: number;
export const COVER_HEIGHT: number;
export const BAND: number;
export const ANY_SIZES: readonly number[];
export const MASKABLE_CANVAS: number;
export const MASKABLE_BAND: number;
export const MASKABLE_INSET: number;
export const FIELD: string;
export const SAFE_RADIUS: number;

export function maskableGeometry(): MaskableGeometry;
