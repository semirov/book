/**
 * `bin/index.mjs`'s implementation: the derived index, inspected and rebuilt by hand.
 *
 * A mis-set `DATA_DIR` was previously invisible — the engine swallowed the failure and the
 * editor simply got `indexSlice: null`. `show` prints the directory it looked in and what it
 * found (or why it found nothing); `rebuild` replaces the artifact from the rows and prints
 * the new hash. Exit codes: 0 done, 1 missing/unbuildable, 2 unknown command.
 */

import { join } from 'node:path';

import { artifactPath, ensureIndex, readIndex, type IndexInput } from './store.ts';
import type { DerivedIndex } from './types.ts';

export type IndexIo = { log: (line: string) => void; error: (line: string) => void };

function count(index: DerivedIndex): Record<string, number> {
  const sum = (pick: (chapter: DerivedIndex['chapters'][number]) => number): number =>
    index.chapters.reduce((total, chapter) => total + pick(chapter), 0);
  return {
    chapters: index.chapters.length,
    written: index.chapters.filter((chapter) => chapter.written).length,
    entities: sum((chapter) => chapter.entities.length),
    promises: sum((chapter) => chapter.promises.length),
    timeMarkers: sum((chapter) => chapter.timeMarkers.length),
    documents: sum((chapter) => chapter.documents.length),
  };
}

function summary(input: IndexInput, index: DerivedIndex): Record<string, unknown> {
  return {
    dataDir: input.dataDir,
    artifact: artifactPath(input.dataDir),
    slices: join(input.dataDir, 'index', 'slices'),
    version: index.version,
    manuscriptHash: index.manuscriptHash,
    ...count(index),
  };
}

/** `bin/index.mjs`'s entry: it opens the volume read-write (the artifact is written) and hands it in. */
export function runIndex(argv: readonly string[], io: IndexIo, input: IndexInput): number {
  const command = argv[0];
  if (command === 'show') {
    const index = readIndex(input.dataDir);
    if (index === null) {
      io.error(
        `index: no derived index at ${artifactPath(input.dataDir)} (DATA_DIR=${input.dataDir}); ` +
          'run `index.mjs rebuild`',
      );
      return 1;
    }
    io.log(JSON.stringify(summary(input, index), null, 2));
    return 0;
  }
  if (command === 'rebuild') {
    try {
      // The same builder the engine uses; a rebuild replaces the artifact wholesale.
      io.log(JSON.stringify(summary(input, ensureIndex(input)), null, 2));
      return 0;
    } catch (error) {
      io.error(`index: rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  io.error('usage: index.mjs <show|rebuild>');
  return 2;
}

