/**
 * BOOK-133 — the cover inside the FB2: one PNG, the exact bytes, never a re-encode.
 *
 * The file is read once and handed to the serializer as base64; nothing here resizes, crops,
 * converts or strips metadata — the drawn frame lives in the image's outer pixels, and any
 * transformation would be a different picture. The module also owns the two XML fragments, so
 * the `coverpage` reference and the `binary` it points at are built from one value: the caller
 * passes the binary's id to both (review M1 — two independent literals could publish a
 * reference with no target).
 *
 * A cover that cannot be embedded is an error, never a placeholder: a book without its cover
 * is not the file the owner promised, and a silent fallback would be a lie in the catalogue.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const COVER_ID = 'cover.png';
export const COVER_TYPE = 'image/png';
/** The FB2 convention: base64 wrapped well below the 255-character line readers tolerate. */
export const COVER_BASE64_WIDTH = 78;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** signature (8) + IHDR length (4) + type (4) + 13 data bytes + CRC (4). */
const PNG_HEADER_BYTES = 33;

export type CoverErrorCode = 'COVER_MISSING' | 'COVER_UNREADABLE' | 'COVER_NOT_PNG';

/** A typed failure the route answers 503 with: the code is public, the path is not a secret. */
export class CoverError extends Error {
  readonly code: CoverErrorCode;

  constructor(code: CoverErrorCode, message: string) {
    super(message);
    this.name = 'CoverError';
    this.code = code;
  }
}

export type CoverImage = {
  /** The file exactly as it is on disk; the embedded base64 decodes back to these bytes. */
  bytes: Buffer;
  /** The same bytes, base64, wrapped at `COVER_BASE64_WIDTH` with `\n` only. */
  base64: string;
  sha256: string;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
};

/** The `binary` element's input: the serializer stays pure, so this is data, not a file. */
export type CoverBinary = { id: string; contentType: string; base64: string };

function wrapBase64(value: string, width: number): string {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return lines.join('\n');
}

/**
 * The PNG signature and the IHDR fields the file must have to be an embeddable image. Only
 * what a reader needs to open it is checked; the word "valid PNG" would be a claim about the
 * CRC of every chunk, and the bytes are passed through untouched in any case.
 */
function readPngHeader(bytes: Buffer, path: string): Omit<CoverImage, 'bytes' | 'base64' | 'sha256'> {
  const notPng = (): never => {
    throw new CoverError('COVER_NOT_PNG', `cover file is not a PNG: ${path}`);
  };
  if (bytes.length < PNG_HEADER_BYTES) notPng();
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) notPng();
  // The first chunk of a PNG is always IHDR, exactly 13 data bytes long.
  if (bytes.readUInt32BE(8) !== 13) notPng();
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') notPng();
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  if (width === 0 || height === 0) notPng();
  if (![1, 2, 4, 8, 16].includes(bitDepth)) notPng();
  if (colorType > 6) notPng();
  return { width, height, bitDepth, colorType };
}

/**
 * Reads the cover once: the bytes, the header facts, the sha256 and the wrapped base64. The
 * caller caches the result; nothing here is memoised, so a changed file is a changed answer.
 */
export function loadCover(path: string): CoverImage {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (missing) throw new CoverError('COVER_MISSING', `cover file is missing at ${path}`);
    throw new CoverError('COVER_UNREADABLE', `cover file is unreadable at ${path}`);
  }
  const header = readPngHeader(bytes, path);
  return {
    bytes,
    base64: wrapBase64(bytes.toString('base64'), COVER_BASE64_WIDTH),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...header,
  };
}

/** The first page: a reference to the id the document's one `binary` carries. */
export function coverPageElement(id: string): string {
  return `   <coverpage><image l:href="#${id}"/></coverpage>`;
}

/** The document's last element: the image itself, the passed base64 unchanged. */
export function binaryElement(cover: CoverBinary): string {
  return [
    ` <binary id="${cover.id}" content-type="${cover.contentType}">`,
    ...cover.base64.split('\n'),
    ' </binary>',
  ].join('\n');
}
