/**
 * ULIDs for engine ids (`chg_`, `stp_`, `csc_`, `lea_`). 26 Crockford-base32 characters:
 * a 48-bit millisecond timestamp then 80 bits of randomness, so ids sort by creation time
 * and are safe to show in URLs. Two ids minted in the same millisecond still order
 * correctly because the random part is incremented, not redrawn.
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  return Array.from(bytes, (byte) => byte % 32);
}

function incrementRandom(value: number[]): number[] {
  const next = [...value];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  return freshRandom();
}

export function ulid(nowMs: number = Date.now()): string {
  if (nowMs === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = nowMs;
    lastRandom = freshRandom();
  }
  return `${encodeTime(nowMs)}${lastRandom.map((digit) => ALPHABET[digit]).join('')}`;
}

export const newChangeId = (nowMs?: number): string => `chg_${ulid(nowMs)}`;
export const newStepId = (nowMs?: number): string => `stp_${ulid(nowMs)}`;
export const newCascadeId = (nowMs?: number): string => `csc_${ulid(nowMs)}`;
export const newLeaseId = (nowMs?: number): string => `lea_${ulid(nowMs)}`;
export const newCommentId = (nowMs?: number): string => `cmt_${ulid(nowMs)}`;
export const newIdentityId = (nowMs?: number): string => `idt_${ulid(nowMs)}`;
export const newSessionId = (nowMs?: number): string => `ses_${ulid(nowMs)}`;
export const newBatchId = (nowMs?: number): string => `bat_${ulid(nowMs)}`;
