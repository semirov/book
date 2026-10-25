import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { databaseFile, openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';

export type Fixture = {
  root: string;
  dataDir: string;
  db: Db;
  manuscript: string;
  /** Write (or overwrite) a manuscript file. */
  write: (name: string, text: string) => void;
  close: () => void;
};

export function createFixture(chapters: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-root-'));
  const manuscript = join(root, 'manuscript');
  mkdirSync(manuscript, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'book-data-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);

  const write = (name: string, text: string): void => {
    mkdirSync(manuscript, { recursive: true });
    writeFileSync(join(manuscript, name), text, 'utf8');
  };

  for (const [name, text] of Object.entries(chapters)) write(name, text);

  return {
    root,
    dataDir,
    db,
    manuscript,
    write,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Prose inside the band, with the title line the chapter format requires (§6C.3). */
export function longProse(paragraphs: string[] = [], title = 'Заголовок главы'): string {
  const filler =
    'Он стоял у окна и смотрел, как по стеклу идёт вода: капля доходила до рамы и поворачивала вбок. ' +
    'За окном был пустой двор, доска на двух кирпичах и след от колеса, оставшийся с ночи.';
  const blocks = [...paragraphs];
  while (blocks.join('\n\n').length < 6500) blocks.push(filler.repeat(2));
  return `${title}\n\n${blocks.join('\n\n')}`;
}
