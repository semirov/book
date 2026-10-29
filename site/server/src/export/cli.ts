/**
 * `bin/export.mjs`'s implementation (BOOK-187 AC11): the book rendered from rows into one path.
 *
 *   node bin/export.mjs --format md|fb2 --out <path> [--data-dir <dir>]
 *
 * Arguments and exit codes live here so the behaviour is testable without a build; the driver
 * (`bin/export.mjs`) resolves the config, opens the volume and hands the connection in.
 * Exit codes: 0 written, 1 the export failed (a cover that cannot be embedded, a path that
 * cannot be written), 2 usage.
 */

import type { Imprint } from '@book/shared';

import type { Db } from '../db/db.ts';
import { exportBook, type ExportFormat } from './book.ts';
import { writeExport } from './write.ts';

export type ExportIo = { log: (line: string) => void; error: (line: string) => void };

export type ExportArgs = { format: ExportFormat; out: string; dataDir: string | null };

const FORMATS: readonly ExportFormat[] = ['md', 'fb2'];

export function parseExportArgs(argv: readonly string[]): ExportArgs | { error: string } {
  let format: ExportFormat | null = null;
  let out: string | null = null;
  let dataDir: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const take = (name: string): string | null => {
      if (arg === name) return argv[index + 1] ?? null;
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      return null;
    };
    if (arg === '--format' || arg.startsWith('--format=')) {
      const value = take('--format');
      if (value === null || value.length === 0) return { error: '--format needs a value (md or fb2)' };
      if (!FORMATS.includes(value as ExportFormat)) return { error: `unknown format "${value}": use md or fb2` };
      format = value as ExportFormat;
      if (arg === '--format') index += 1;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = take('--out');
      if (value === null || value.length === 0) return { error: '--out needs a path' };
      out = value;
      if (arg === '--out') index += 1;
      continue;
    }
    if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const value = take('--data-dir');
      if (value === null || value.length === 0) return { error: '--data-dir needs a directory' };
      dataDir = value;
      if (arg === '--data-dir') index += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  if (format === null) return { error: '--format md|fb2 is required' };
  if (out === null) return { error: '--out <path> is required (the export writes exactly this path and nothing else)' };
  return { format, out, dataDir };
}

export type ExportDeps = {
  db: Db;
  imprint: Imprint;
  version: string;
  publicOrigin: string;
  coverPath: string;
};

/** Render and write one export; print the path and its size. */
export function runExport(args: ExportArgs, io: ExportIo, deps: ExportDeps): number {
  try {
    const body = exportBook(args.format, deps);
    const written = writeExport(args.out, body);
    io.log(`${written.path}: ${String(written.bytes)} bytes`);
    return 0;
  } catch (error) {
    io.error(`export: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
