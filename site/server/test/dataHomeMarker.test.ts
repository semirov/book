/**
 * The volume marker's two shapes, in the module that owns them (BOOK-187 fix review).
 *
 * The live volume carries the legacy three bytes (`28\n`); boot writes the named shape and
 * upgrades the legacy one, and the deploy gate refuses anything that is neither. These tests are
 * the marker's contract, kept apart from the allow-list's so each file stays readable.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MARKER_FORMAT,
  isLegacyVolumeMarker,
  readVolumeMarker,
  volumeMarkerContent,
  volumeMarkerProblem,
} from '../src/dataHome.ts';

/** The marker `server/src/db/boot.ts` writes today, with the schema number this volume carries. */
const NAMED_MARKER = 'book-volume 1\nschema=28\n';

describe('the volume marker — one module owns its two shapes', () => {
  it('builds the named shape from the format version, not a literal in the regex', () => {
    expect(MARKER_FORMAT).toBe(1);
    expect(volumeMarkerContent(28)).toBe('book-volume 1\nschema=28\n');
    expect(volumeMarkerProblem(volumeMarkerContent(28))).toBeNull();
    // A different format is not this marker.
    expect(volumeMarkerProblem('book-volume 2\nschema=28\n')).not.toBeNull();
  });

  it('accepts the named shape boot writes today', () => {
    expect(volumeMarkerProblem(NAMED_MARKER)).toBeNull();
    // Trailing newline optional, `\r\n` normalised, any schema number.
    expect(volumeMarkerProblem('book-volume 1\nschema=28')).toBeNull();
    expect(volumeMarkerProblem('book-volume 1\r\nschema=28\r\n')).toBeNull();
    expect(volumeMarkerProblem('book-volume 1\nschema=0\n')).toBeNull();
    expect(isLegacyVolumeMarker(NAMED_MARKER)).toBe(false);
  });

  it('accepts the legacy number the first image wrote, and knows it is the one to upgrade', () => {
    // The live `book-data` volume carries exactly these three bytes: BOOK-187's first image wrote
    // the schema version alone, before the marker carried its volume's name.
    expect(volumeMarkerProblem('28\n')).toBeNull();
    expect(volumeMarkerProblem('28')).toBeNull();
    expect(volumeMarkerProblem('0\r\n')).toBeNull();
    expect(isLegacyVolumeMarker('28\n')).toBe(true);
    expect(isLegacyVolumeMarker(NAMED_MARKER)).toBe(false);
  });

  it('refuses everything else, and says what a marker is', () => {
    for (const content of ['', '\n', 'hello', '28 28', 'book-volume 1', 'book-volume 2\nschema=28\n', 'book-volume 1\nschema=28\nextra\n', 'schema=28\n']) {
      expect(volumeMarkerProblem(content), JSON.stringify(content)).not.toBeNull();
      expect(isLegacyVolumeMarker(content), JSON.stringify(content)).toBe(false);
    }
    expect(volumeMarkerProblem('hello')).toContain('book-volume 1');
  });

  it('reads the marker only when it is a small regular file', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-marker-read-'));
    try {
      const data = join(root, 'data');
      mkdirSync(join(data, '.book-volume'), { recursive: true });
      // A directory of that name is not a marker and is not read.
      expect(readVolumeMarker(data)).toBeNull();
      rmSync(join(data, '.book-volume'), { recursive: true, force: true });

      // A file too large to be a marker (a FIFO or a megabyte of prose) must not hold the gate.
      writeFileSync(join(data, '.book-volume'), 'x'.repeat(5 * 1024));
      expect(readVolumeMarker(data)).toBeNull();

      writeFileSync(join(data, '.book-volume'), '28\n');
      expect(readVolumeMarker(data)).toBe('28\n');

      rmSync(join(data, '.book-volume'), { force: true });
      expect(readVolumeMarker(data)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
