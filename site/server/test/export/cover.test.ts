import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  COVER_BASE64_WIDTH,
  COVER_ID,
  COVER_TYPE,
  CoverError,
  binaryElement,
  coverPageElement,
  loadCover,
} from '../../src/fb2/cover.ts';

/**
 * BOOK-133 — the source cover as the exporter sees it. The assertions name the real asset in
 * `web/public/cover/cover.png`: its length, its IHDR and its hash are the contract with the
 * drawn image, and every one of them would change if the exporter converted a single byte.
 */

/** `site/server/test/export` → `site/`. */
const SOURCE = resolve(import.meta.dirname, '..', '..', '..', 'web', 'public', 'cover', 'cover.png');
const SHA256 = '9491eb0b5b5832950352899c72b1e4bc5c51ed52731836bbcdab27c02e695c94';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-cover-'));
  tempDirs.push(dir);
  return dir;
}

/** The thrown failure, asserted to be the typed one the route answers with. */
function failureOf(run: () => unknown): CoverError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CoverError);
    return error as CoverError;
  }
  throw new Error('expected a CoverError, but the call returned');
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('the cover (BOOK-133)', () => {
  it('the source cover: 1 108 247 bytes, PNG 1024×1536, bit depth 8, colour type 0, sha256 9491eb0b…695c94', () => {
    const cover = loadCover(SOURCE);
    expect(cover.bytes.length).toBe(1_108_247);
    expect(cover.width).toBe(1024);
    expect(cover.height).toBe(1536);
    expect(cover.bitDepth).toBe(8);
    expect(cover.colorType).toBe(0);
    expect(cover.sha256).toBe(SHA256);
    // Read once, byte for byte: the module converts nothing.
    expect(Buffer.compare(cover.bytes, readFileSync(SOURCE))).toBe(0);
  });

  it('base64: 78-character lines, no `\\r`, decodes byte-for-byte to the source (length and sha256 equal)', () => {
    const cover = loadCover(SOURCE);
    const lines = cover.base64.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(cover.base64).not.toContain('\r');
    for (const line of lines.slice(0, -1)) expect(line.length).toBe(COVER_BASE64_WIDTH);
    expect(lines.at(-1)!.length).toBeGreaterThan(0);
    expect(lines.at(-1)!.length).toBeLessThanOrEqual(COVER_BASE64_WIDTH);

    const decoded = Buffer.from(cover.base64.replace(/\n/gu, ''), 'base64');
    expect(decoded.length).toBe(1_108_247);
    expect(Buffer.compare(decoded, cover.bytes)).toBe(0);
    expect(loadCover(SOURCE).sha256).toBe(SHA256);
  });

  it('a missing file fails with COVER_MISSING and names the path; a non-PNG fails with COVER_NOT_PNG', () => {
    const missing = join(tempDir(), 'no-cover.png');
    const absent = failureOf(() => loadCover(missing));
    expect(absent.code).toBe('COVER_MISSING');
    expect(absent.message).toBe(`cover file is missing at ${missing}`);

    const textFile = join(tempDir(), 'cover.png');
    writeFileSync(textFile, 'not a PNG at all, just a sentence of the wrong kind\n', 'utf8');
    const notPng = failureOf(() => loadCover(textFile));
    expect(notPng.code).toBe('COVER_NOT_PNG');
    expect(notPng.message).toBe(`cover file is not a PNG: ${textFile}`);

    // A truncated file is structurally not a PNG even if a reader saved the signature.
    const truncated = join(tempDir(), 'truncated.png');
    writeFileSync(truncated, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(failureOf(() => loadCover(truncated)).code).toBe('COVER_NOT_PNG');

    // A directory reads as nothing a reader can open: unreadable, and named as such.
    const directory = tempDir();
    const unreadable = failureOf(() => loadCover(directory));
    expect(unreadable.code).toBe('COVER_UNREADABLE');
    expect(unreadable.message).toBe(`cover file is unreadable at ${directory}`);
  });

  it('rejects a header a reader could not open: a broken IHDR is not a PNG', () => {
    const header = (fields: {
      length?: number;
      type?: string;
      width?: number;
      height?: number;
      bitDepth?: number;
      colorType?: number;
    }): Buffer => {
      const bytes = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
      bytes.writeUInt32BE(fields.length ?? 13, 8);
      bytes.write(fields.type ?? 'IHDR', 12, 'latin1');
      bytes.writeUInt32BE(fields.width ?? 1, 16);
      bytes.writeUInt32BE(fields.height ?? 1, 20);
      bytes[24] = fields.bitDepth ?? 8;
      bytes[25] = fields.colorType ?? 0;
      return bytes;
    };
    for (const [label, fields] of [
      ['a non-IHDR first chunk', { type: 'IDAT' }],
      ['an IHDR of the wrong length', { length: 14 }],
      ['a zero width', { width: 0 }],
      ['a zero height', { height: 0 }],
      ['an impossible bit depth', { bitDepth: 3 }],
      ['an unknown colour type', { colorType: 7 }],
    ] as const) {
      const path = join(tempDir(), 'cover.png');
      writeFileSync(path, header(fields));
      expect(failureOf(() => loadCover(path)).code, label).toBe('COVER_NOT_PNG');
    }
  });

  it('builds both fragments from one id: the coverpage reference is the binary the document carries', () => {
    const cover = loadCover(SOURCE);
    expect(COVER_ID).toBe('cover.png');
    expect(COVER_TYPE).toBe('image/png');
    expect(coverPageElement(COVER_ID)).toBe('   <coverpage><image l:href="#cover.png"/></coverpage>');

    const binary = binaryElement({ id: COVER_ID, contentType: COVER_TYPE, base64: cover.base64 });
    const lines = binary.split('\n');
    expect(lines[0]).toBe(' <binary id="cover.png" content-type="image/png">');
    expect(lines.at(-1)).toBe(' </binary>');
    expect(lines.slice(1, -1).join('\n')).toBe(cover.base64);

    // Review M1: the reference follows the id it is given, so it can never name a target the
    // binary does not carry — the two fragments take one value, not two literals.
    const other = { id: 'plate.png', contentType: COVER_TYPE, base64: 'ZmFrZQ==' };
    expect(coverPageElement(other.id)).toContain('l:href="#plate.png"');
    expect(binaryElement(other)).toContain('id="plate.png"');
  });
});
