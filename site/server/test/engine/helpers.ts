/**
 * Test harness for the engine: a temporary book root, a database, a controllable clock and
 * a **scripted session** that plays writer, editor and consultant without a model (M3
 * stubs the model out; M6 swaps the ports, not the protocol).
 *
 * The scripted writer is the only thing here that writes to `manuscript/` — exactly as in
 * production, where the engine mounts the book read-only and the session on the host owns the
 * file. Nothing in `server/src` writes prose, and the arch test enforces it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAPTER_CHARS } from '@book/shared';
import type {
  Finding,
  SeamRef,
  StepPass,
  WriterAssignment,
} from '@book/shared';

import { loadConfig, type Config } from '../../src/config.ts';
import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { createEngine, type DoneResult } from '../../src/engine/service.ts';
import type { Clock, EngineAlert, EngineDeps } from '../../src/engine/types.ts';

export class FakeClock implements Clock {
  ms: number;

  constructor(start = Date.UTC(2026, 9, 25, 9, 0, 0)) {
    this.ms = start;
  }

  now(): number {
    return this.ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

export type Fixture = {
  root: string;
  manuscript: string;
  dataDir: string;
  db: Db;
  config: Config;
  clock: FakeClock;
  engine: ReturnType<typeof createEngine>;
  deps: EngineDeps;
  alerts: EngineAlert[];
  writeChapter: (n: number, text: string) => void;
  writeChapterBlocks: (n: number, title: string, blocks: string[]) => void;
  writeFront: (title: string, about: string) => void;
  readChapter: (n: number) => string | null;
  /** The first sheet's annotation, for a scripted front step. */
  readFrontBlocks: () => string;
  close: () => void;
};

export const DEFAULT_ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
/**
 * Fixture text is synthetic on purpose: a test never depends on the book's prose. A fixture
 * front carries the live untitled name «Без названия» until a scripted front step changes it.
 */

/**
 * A scripted session writes **a page**, not a slot: `land` refuses a written chapter below
 * `CHAPTER_CHARS.floor` (canon, BOOK-DOC-4 — the floor is a limit, not a hint). The filler is
 * one fixed, inert paragraph (lower case, no digits, no names): it is appended as its own
 * block, so a test's own paragraphs and their count are exactly what it wrote, a small edit
 * stays a small delta, and the same paragraph is `kept` across writes. A test that needs a
 * chapter below the floor writes it with `fixture.writeChapter`, which never pads.
 */
const FILLER_SENTENCE = 'служебный абзац для проверки объёма страницы, он не является текстом книги. ';
const FILLER_BLOCK = FILLER_SENTENCE.repeat(24).trimEnd();

function padToFloor(blocks: string[]): string[] {
  if (blocks.length === 0) return blocks;
  const chars = blocks.reduce((sum, block) => sum + block.length, 0);
  return chars >= CHAPTER_CHARS.floor ? blocks : [...blocks, FILLER_BLOCK];
}

export function chapterText(title: string, blocks: string[]): string {
  return `${title}\n\n${padToFloor(blocks).join('\n\n')}\n`;
}

export function createEngineFixture(options: {
  chapters?: Record<number, string>;
  front?: { title: string; about: string } | null;
  env?: Record<string, string>;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-engine-root-'));
  const manuscript = join(root, 'manuscript');
  mkdirSync(manuscript, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'book-engine-data-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);

  const config = loadConfig({
    BOOK_ROOT: root,
    DATA_DIR: dataDir,
    LOG_LEVEL: 'error',
    // The owner's writing switch: the engine drafts only when it is on (BOOK-6); the tests
    // that exercise a pass say so once, here, and the refusal test turns it off.
    DRAFTING: 'on',
    ...options.env,
  });
  const clock = new FakeClock();
  const alerts: EngineAlert[] = [];
  const deps: EngineDeps = {
    db,
    config,
    bookRoot: root,
    clock,
    alert: (alert) => alerts.push(alert),
  };
  const engine = createEngine(deps);

  const writeChapter = (n: number, text: string): void => {
    writeFileSync(join(manuscript, `ch${String(n).padStart(2, '0')}.md`), text, 'utf8');
  };
  const writeChapterBlocks = (n: number, title: string, blocks: string[]): void => {
    writeChapter(n, chapterText(title, blocks));
  };
  const writeFront = (title: string, about: string): void => {
    writeFileSync(join(manuscript, '00-front.md'), `${title}\n\n${about}\n`, 'utf8');
  };

  if (options.front !== null) {
    const front = options.front ?? { title: 'Без названия', about: DEFAULT_ABOUT };
    writeFront(front.title, front.about);
  }
  for (const [n, text] of Object.entries(options.chapters ?? {})) {
    writeChapter(Number(n), text);
  }

  return {
    root,
    manuscript,
    dataDir,
    db,
    config,
    clock,
    engine,
    deps,
    alerts,
    writeChapter,
    writeChapterBlocks,
    writeFront,
    readChapter: (n) => {
      try {
        return readFileSync(join(manuscript, `ch${String(n).padStart(2, '0')}.md`), 'utf8');
      } catch {
        return null;
      }
    },
    readFrontBlocks: () => {
      try {
        const raw = readFileSync(join(manuscript, '00-front.md'), 'utf8');
        return raw.split('\n').slice(2).join('\n').trim();
      } catch {
        return DEFAULT_ABOUT;
      }
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export type GateScript = { verdict: 'HOLDS' | 'GAP'; findings?: Finding[] };

export type StubScript = {
  title?: string;
  blocks?: string[];
  /** What the writer lands on a revision cycle (defaults to blocks plus a marker). */
  revisionBlocks?: string[];
  noWrite?: boolean;
  seams?: SeamRef[];
  note?: string;
  editor?: GateScript;
  consultant?: GateScript;
  /** The relevance answer a writer gives before touching a moved base (§6A.7). */
  decision?: { decision: 'adapt' | 'drop' | 'void'; reason: string; intent?: string };
  /** Stop after this many writer revisions (guards a runaway loop in the harness). */
  maxRevisions?: number;
};

export type StubRun = {
  assignment: WriterAssignment;
  stepId: string;
  revisions: number;
  result: DoneResult;
};

function defaultBlocks(pass: StepPass, chapter: number | 'front'): string[] {
  return [
    `Черновик ${pass} ${String(chapter)}: служебный текст для проверки.`,
    'Это служебный текст, он не является текстом книги.',
  ];
}

function writeFor(fixture: Fixture, assignment: WriterAssignment, script: StubScript, blocks: string[]): void {
  if (assignment.chapter === 'front') {
    fixture.writeFront(script.title ?? 'Без названия', blocks.join('\n\n'));
    return;
  }
  fixture.writeChapterBlocks(assignment.chapter, script.title ?? `Глава ${assignment.chapter}`, blocks);
}

function submitGate(fixture: Fixture, role: 'editor' | 'consultant', script: StubScript) {
  const gate = fixture.engine.next({ role, session: `${role}-stub` }) as GateAssignment | null;
  if (!gate) throw new Error(`no ${role} assignment for the landed step`);
  const plan = role === 'editor' ? script.editor : script.consultant;
  return fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict: plan?.verdict ?? 'HOLDS',
    findings: plan?.findings ?? [],
    model: 'stub/deepseek-flash',
    tokensIn: 120,
    tokensOut: 12,
  });
}

/**
 * Drive the next job the engine offers through the full three-role pass. The writer lands a
 * revision; the editor answers first; a `GAP` with a blocker forces a revision (and the
 * harness rewrites the leased file, as a real session would); then the consultant. The step
 * closes with the seams the script reports.
 */
export function runStubStep(fixture: Fixture, script: StubScript, lane: 'fwd' | 'bwd' = 'fwd'): StubRun | null {
  const assignment = fixture.engine.next({ for: lane, session: `writer-${lane}` }) as WriterAssignment | null;
  if (!assignment) return null;
  return driveStub(fixture, assignment, script);
}

export function driveStub(fixture: Fixture, assignment: WriterAssignment, script: StubScript): StubRun {
  const engine = fixture.engine;
  if (script.decision) {
    engine.start(assignment.leaseId, script.decision);
    if (script.decision.decision !== 'adapt') {
      return {
        assignment,
        stepId: assignment.stepId,
        revisions: 0,
        result: { stepId: assignment.stepId, outcome: 'holds', cascadeId: null, changeStatus: 'void' },
      };
    }
  } else {
    engine.start(assignment.leaseId);
  }

  const blocks = script.blocks ?? defaultBlocks(assignment.pass, assignment.chapter);
  const revisionOf = (base: string[], n: number): string[] =>
    base.map((block, index) => (index === base.length - 1 ? `${block} Правка ${n}.` : block));
  if (script.noWrite === true || assignment.pass === 'ending') {
    engine.land(assignment.leaseId, { noWrite: true });
  } else {
    writeFor(fixture, assignment, script, blocks);
    engine.land(assignment.leaseId);
  }

  let revisions = 0;
  const maxRevisions = script.maxRevisions ?? 4;
  for (;;) {
    const editor = submitGate(fixture, 'editor', script);
    if (editor.action === 'revise') {
      if (revisions >= maxRevisions) throw new Error('the harness looped on editor revisions');
      revisions += 1;
      writeFor(fixture, assignment, script, revisionOf(script.revisionBlocks ?? blocks, revisions));
      engine.land(assignment.leaseId);
      continue;
    }
    const consultant = submitGate(fixture, 'consultant', script);
    if (consultant.action === 'revise') {
      if (revisions >= maxRevisions) throw new Error('the harness looped on consultant revisions');
      revisions += 1;
      writeFor(fixture, assignment, script, revisionOf(script.revisionBlocks ?? blocks, revisions));
      engine.land(assignment.leaseId);
      continue;
    }
    break;
  }

  const result = engine.done(assignment.leaseId, {
    seams: script.seams ?? [],
    note: script.note ?? 'scripted session',
    model: 'stub/deepseek-flash',
    tokensIn: 500,
    tokensOut: 80,
  });
  return { assignment, stepId: assignment.stepId, revisions, result };
}
