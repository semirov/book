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

import { CHAPTER_CHARS, frameSentenceOf } from '@book/shared';
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
import { admitPremise } from '../../src/engine/premise.ts';
import { nextDraftChapter } from '../../src/engine/draft.ts';
import { writtenChapters } from '../../src/engine/text.ts';
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
  /**
   * BOOK-166: the production rule is «no pass without a filing». Legacy engine tests were written
   * before it and ask for a chapter directly, so the fixture plays the reader who filed on that
   * chapter (`auto`, the default). A test about the rule itself says `manual` and files by hand.
   */
  filings?: 'auto' | 'manual';
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
  if ((options.filings ?? 'auto') === 'auto') {
    // The fixture's reader: a filing on the chapter a legacy test asks to write.
    const fileIfEmpty = (chapter: number): void => {
      try {
        fileOn({ db }, chapter);
      } catch {
        // A pending premise already exists (the partial unique index): nothing to do.
      }
    };
    const nextRaw = engine.next.bind(engine);
    engine.next = (input) => {
      if (input.for === 'fwd' || input.for === 'bwd') {
        const slot = nextDraftChapter(writtenChapters(root), input.for);
        if (slot !== null) fileIfEmpty(slot);
      }
      return nextRaw(input);
    };
    const passRaw = engine.openChapterPass.bind(engine);
    // BOOK-173: a ripple step (`changeId` present) is never given a filing of its own — the change
    // it serves already exists, and the chapter it patches is written.
    engine.openChapterPass = (chapter, session, changeId) => {
      if (changeId === undefined) fileIfEmpty(chapter);
      return passRaw(chapter, session, changeId);
    };
  }

  const writeChapter = (n: number, text: string): void => {
    writeFileSync(join(manuscript, `ch${String(n).padStart(2, '0')}.md`), text, 'utf8');
  };
  /**
   * BOOK-137: the canon frame opens ch01 and closes ch42, so a chapter written by paragraph
   * carries it — the land guard refuses a landing that lets the sentence move, exactly as in
   * production. A test that needs a byte-exact file (a basis-only slot, a broken frame) writes
   * it with `writeChapter`, which stays raw.
   */
  const writeChapterBlocks = (n: number, title: string, blocks: string[]): void => {
    writeChapter(n, chapterText(title, withFrame(n, blocks)));
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

/**
 * The model a scripted session declares (ADR-038, BOOK-62). It is **recorded, not called**:
 * the deterministic suite still runs no model, but the engine now refuses any close or verdict
 * whose declared model is not the pipeline's, so the script must name the pinned one. Exported
 * once, from the loaded fixture, so no second literal of the model lives in test code.
 */
export const PIPELINE_MODEL = loadConfig({}).pipeline.model;

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

/**
 * BOOK-137: a session that lands on ch01 or ch42 must keep the canon sentence — the land guard
 * refuses a landing whose frame is not character-identical, exactly as production does. The
 * scripted writer is a session, so it keeps the frame the way a live one has to.
 */
function withFrame(chapter: number | 'front', blocks: string[]): string[] {
  const frame = typeof chapter === 'number' ? frameSentenceOf(chapter) : null;
  if (frame === null || blocks.length === 0) return blocks;
  // `chapterText` pads an empty list to a page on its own, so the frame rides the first block.
  const last = blocks.length - 1;
  const merged = (block: string): string => (block.includes(frame) ? block : `${block} ${frame}`);
  return chapter === 1
    ? [`${frame} ${blocks[0] ?? ''}`.trim(), ...blocks.slice(1)]
    : [...blocks.slice(0, last), merged(blocks[last] ?? '')];
}

function writeFor(fixture: Fixture, assignment: WriterAssignment, script: StubScript, blocks: string[]): void {
  if (assignment.chapter === 'front') {
    fixture.writeFront(script.title ?? 'Без названия', blocks.join('\n\n'));
    return;
  }
  // `writeChapterBlocks` keeps the frame of ch01/ch42 itself, so every scripted writer does.
  fixture.writeChapterBlocks(assignment.chapter, script.title ?? `Глава ${assignment.chapter}`, blocks);
}

/**
 * Gate B (BOOK-61): every prose pass carries a rights answer. A clean scan is answered
 * mechanically here exactly as the lane does it — no model, no tokens, `CLEAR`.
 */
export function submitRights(fixture: Fixture): void {
  const gate = fixture.engine.next({ role: 'rights', session: 'rights-stub' }) as
    | { stepId: string; session: string; rule: string | null }
    | null;
  if (!gate) return;
  fixture.engine.verdictRights(gate.stepId, {
    role: 'rights',
    session: gate.session,
    verdict: 'CLEAR',
    rule: null,
    model: PIPELINE_MODEL,
    tokensIn: 0,
    tokensOut: 0,
  });
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
    model: PIPELINE_MODEL,
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

  submitRights(fixture);
  const result = engine.done(assignment.leaseId, {
    seams: script.seams ?? [],
    note: script.note ?? 'scripted session',
    model: PIPELINE_MODEL,
    tokensIn: 500,
    tokensOut: 80,
  });
  return { assignment, stepId: assignment.stepId, revisions, result };
}

/** BOOK-166: the book is written only on a filing — a draft step needs the reader's premise. */
export function fileOn(fixture: { db: Db }, chapter: number): void {
  admitPremise(fixture.db, {
    id: `chg_filing_${String(chapter)}`,
    kind: 'operator',
    chapter,
    intent: `замысел главы ${String(chapter)}: читатель просит начать с документа`,
    interventionKind: 'document',
    sourceComment: null,
    sourceSession: null,
    at: '2026-10-25T09:00:00Z',
  });
}

