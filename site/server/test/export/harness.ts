/**
 * The wire-level harness both export test files share: one app booted over a fixture, a temp
 * directory for the cover operand, and the small readers of the file — the tag, the version,
 * the `binary` payload.
 *
 * The endpoint is read as one document; its tests are two because a file is a unit of the
 * build, not of the reading (the house limit is 500 lines). This one holds what both need, so
 * neither has to grow a second `boot` that could drift from the other's.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import type { Fb2Renderer } from '../../src/fb2/serialize.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { createFixture, type Fixture } from '../helpers.ts';

/** `site/server/test/export` → `site/`. */
export const COVER_SOURCE = resolve(import.meta.dirname, '..', '..', '..', 'web', 'public', 'cover', 'cover.png');

/**
 * BOOK-138: the exact header, both forms. The escape is what `encodeURIComponent('Бланк')`
 * writes for the book's name, so a rename cannot leave the two forms disagreeing.
 */
export const DISPOSITION = `attachment; filename="blank.fb2"; filename*=UTF-8''%D0%91%D0%BB%D0%B0%D0%BD%D0%BA.fb2`;

export type ExportHarness = { app: FastifyInstance; fixture: Fixture };

const tempDirs: string[] = [];

/** A directory for an operand (a copied cover), removed by `cleanup`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-cover-'));
  tempDirs.push(dir);
  return dir;
}

export async function bootExport(
  options: {
    chapters?: Record<string, string>;
    env?: Record<string, string>;
    now?: () => Date;
    fb2?: { render: Fb2Renderer };
  } = {},
): Promise<ExportHarness> {
  const fixture = createFixture(options.chapters ?? {});
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const webDist = join(fixture.dataDir, 'web');
  mkdirSync(webDist, { recursive: true });
  const app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: webDist,
      PORT: '8080',
      ...options.env,
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.fb2 === undefined ? {} : { fb2: options.fb2 }),
  });
  return { app, fixture };
}

/** Close the app, close the fixture and remove every temp directory this file made. */
export async function cleanup(harness: ExportHarness | null): Promise<void> {
  await harness?.app.close();
  harness?.fixture.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The document's one `binary` payload, whitespace stripped: the base64 the file carries. */
export function binaryOf(xml: string): string {
  const match = /<binary[^>]*>([\s\S]*)<\/binary>/u.exec(xml);
  if (match === null) throw new Error('the file carries no binary element');
  return match[1]!.replace(/\s+/gu, '');
}

/** `document-info/version` as written; a file without one is a failure, not a default. */
export function versionOf(xml: string): string {
  const match = /<version>(\d+)<\/version>/u.exec(xml);
  if (match === null) throw new Error('the file carries no document-info/version');
  return match[1]!;
}

/** The file minus its one date element, for "two exports differ only in the date". */
export function withoutDate(xml: string): string {
  return xml.replace(/<date value="[^"]*">[^<]*<\/date>/u, '<date/>');
}
