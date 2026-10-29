import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FRAME_REGISTRY, type ServerEventType } from '@book/shared';

/**
 * BOOK-DOC-84 §6 — **there is no dead frame type**.
 *
 * A `ServerEventType` must have a registered emitter and a registered handler, or an explicit
 * `transport` mark (only `pong`, which is liveness and has no surface by design). This is the
 * fitness function the state table demanded: 3 types were registered with no emitter and never
 * noticed until an analyst grepped the source.
 *
 * Two checks, because a registry alone would be a promise:
 *  · every type is in the registry, with both sides (or `pong`'s transport mark) — no extras;
 *  · every non-transport type appears as a **string literal** in `server/src`, so the emitter the
 *    registry names is a place in the code, not a wish.
 */

const SRC = join(import.meta.dirname, '..', 'src');

/** Every `.ts` file of the server source, concatenated: emitters are literals in these files. */
function serverSource(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts')) files.push(path);
    }
  };
  walk(SRC);
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

const TYPES = Object.keys(FRAME_REGISTRY) as ServerEventType[];

describe('the frame registry', () => {
  it('has exactly the 26 types of BOOK-DOC-84 §2.1 + §10.1', () => {
    expect(TYPES).toHaveLength(26);
    expect(new Set(TYPES).size).toBe(26);
    // The deleted three are gone: no handler, no emitter, no type.
    for (const deleted of ['block:revising', 'cursor:moved', 'presence']) {
      expect(TYPES).not.toContain(deleted);
    }
    // …and the six added ones are in (the fifth is §10.1's `filing:reading`).
    for (const added of ['chapter:applied', 'pass:accepted', 'pass:closed', 'filing:update', 'filing:reading', 'change:adapted']) {
      expect(TYPES).toContain(added);
    }
  });

  it('gives every type an emitter and a handler, or marks it transport (pong only)', () => {
    for (const type of TYPES) {
      const entry = FRAME_REGISTRY[type];
      expect(entry.emitter.length, `${type} has an emitter`).toBeGreaterThan(0);
      if (entry.transport === true) {
        expect(type, 'transport is reserved for pong').toBe('pong');
        expect(entry.handler).toBeNull();
        continue;
      }
      expect(entry.handler, `${type} has a handler`).not.toBeNull();
      expect(String(entry.handler).length, `${type} handler is named`).toBeGreaterThan(0);
    }
  });

  it('names an emitter that exists as a literal in server/src', () => {
    const source = serverSource();
    for (const type of TYPES) {
      if (FRAME_REGISTRY[type].transport === true) continue;
      expect(source.includes(`'${type}'`), `no emitter literal for ${type}`).toBe(true);
    }
  });

  it('names a handler beside the emitter, and never the same one twice', () => {
    const handlers = new Map<string, string>();
    for (const type of TYPES) {
      const handler = FRAME_REGISTRY[type].handler;
      if (handler === null) continue;
      // A handler is a location: `file → function`. One function may serve several frames
      // (`lib/frames.ts → snapshot`), but no two frames may claim the same *entry*.
      expect(handler).toContain('→');
      const previous = handlers.get(handler);
      expect(previous, `${type} and ${String(previous)} share the handler ${handler}`).toBeUndefined();
      handlers.set(handler, type);
    }
  });
});
