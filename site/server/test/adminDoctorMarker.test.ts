/**
 * BOOK-187 fix — the doctor's `db_home` row over a **real** data dir, not a stub body.
 *
 * The preflight and the deploy guard used to own two allow-lists, and the live volume's
 * `.book-volume` was a marker to one and a stray to the other. `server/src/doctor/inspect.ts` now
 * classifies with `server/src/dataHome.ts`, and this file feeds the real classifier's answer into
 * the real row: a bad marker is one absolute path in one line, and the legacy marker passes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { printDoctorReport, runDoctor } from '../../bin/adminDoctor.mjs';
import type { DoctorReport } from '../../bin/adminDoctor.mjs';
import { inspectDataDir } from '../src/doctor/inspect.ts';
import {
  HOUR,
  TOKEN,
  byId,
  closeDoctors,
  dockerStub,
  doctorBody,
  fetchLike,
  makeHostBackup,
  makeRepo,
  readyRoutes,
  stubServer,
  utcStamp,
  writeLog,
} from './adminDoctorFixtures.ts';

const dirs: string[] = [];

afterEach(async () => {
  await closeDoctors();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The doctor over a stack and a host that are ready, with the data dir read from `volume`. */
async function reportOver(volume: string): Promise<DoctorReport> {
  const root = mkdtempSync(join(tmpdir(), 'book-doctor-marker-'));
  dirs.push(root);
  const repo = makeRepo(root);
  const backups = join(root, 'backups');
  makeHostBackup(backups, '20261028T060000', HOUR);
  const log = writeLog(join(root, 'book-backup.log'), [`${utcStamp(HOUR)} level=info job=book-backup-drill status=ok`]);
  const stack = await stubServer(readyRoutes(doctorBody({ dataDir: inspectDataDir(volume) })));
  return runDoctor({
    target: new URL(stack.base),
    token: TOKEN,
    repoRoot: repo,
    backupRoot: backups,
    drillLog: log,
    docker: dockerStub(),
    fetchImpl: fetchLike,
  });
}

describe('doctor db_home — the volume marker, from the real classifier', () => {
  it('names a marker whose content is not a marker, by its absolute path, in one line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-doctor-volume-'));
    dirs.push(root);
    const volume = join(root, 'data');
    mkdirSync(volume, { recursive: true });
    writeFileSync(join(volume, 'book.db'), '');
    const marker = join(volume, '.book-volume');
    writeFileSync(marker, 'not a marker\n');

    const report = await reportOver(volume);
    expect(byId(report, 'db_home').verdict).toBe('fail');
    expect(byId(report, 'db_home').failures).toEqual([
      `the data dir has a stray entry ${marker} — not on the allow-list`,
    ]);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      printDoctorReport(report);
      expect(lines.some((line) => line.startsWith('  - db_home: '))).toBe(true);
      expect(lines.join('\n')).toContain(`the data dir has a stray entry ${marker}`);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes the live volume’s legacy marker (`28\\n`) and a stray file is still named', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-doctor-volume-'));
    dirs.push(root);
    const volume = join(root, 'data');
    mkdirSync(volume, { recursive: true });
    writeFileSync(join(volume, 'book.db'), '');
    // Exactly what `book-data` carries today: BOOK-187's first image wrote the schema alone.
    writeFileSync(join(volume, '.book-volume'), '28\n');

    const legacy = await reportOver(volume);
    expect(byId(legacy, 'db_home')).toMatchObject({ verdict: 'pass', evidence: 'data dir clean' });

    writeFileSync(join(volume, 'notes.txt'), 'prose');
    const stray = await reportOver(volume);
    expect(byId(stray, 'db_home').verdict).toBe('fail');
    expect(byId(stray, 'db_home').failures).toEqual([
      `the data dir has a stray entry ${join(volume, 'notes.txt')} — not on the allow-list`,
    ]);
  });
});
