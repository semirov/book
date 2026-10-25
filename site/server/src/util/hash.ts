import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha1Hex(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}
