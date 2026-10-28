/**
 * Test harness for the engine: a temporary book root, a database, a controllable clock and
 * a **scripted session** that plays writer, editor and consultant without a model (M3
 * stubs the model out; M6 swaps the ports, not the protocol).
 *
 * Since BOOK-187 the book's text lives in rows and nowhere else, so the fixture has no
 * `manuscript/` at all: `seedChapter` publishes a chapter that already exists (the site has
 * served it), and `writeChapter`/`writeFront` are the **scripted session's own answer**, held
 * in memory and sent to `land` in the request — exactly as the writer lane does it. A test that
 * asserts a file was written cannot pass here, which is the point.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { withFrame as withFrameText } from '../helpers.ts';
import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { admitPremise } from '../../src/engine/premise.ts';
import { nextDraftChapter } from '../../src/engine/draft.ts';
import { readChapterRows, readFrontRows, writtenChaptersOf } from '../../src/engine/text.ts';
import { applyChapterFile } from '../../src/ingest/applyChapter.ts';
import { applyFrontFile } from '../../src/ingest/applyFront.ts';
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
  /** Publish a chapter the way the one-shot import does: the site has already served it. */
  seedChapter: (n: number, text: string) => void;
  /** The same, by paragraph, keeping the canon frame of ch01/ch42 — a book that exists. */
  seedChapterBlocks: (n: number, title: string, blocks: string[]) => void;
  /** Publish the first sheet as a row (the basis an existing book starts from). */
  seedFront: (title: string, about: string) => void;
  /** The scripted session's answer for chapter `n`: held in memory, sent by `land`. */
  writeChapter: (n: number, text: string) => void;
  /** The same, keeping the canon frame of ch01/ch42 (BOOK-137). */
  writeChapterBlocks: (n: number, title: string, blocks: string[]) => void;
  /** The scripted front lane's answer: the whole first sheet, sent by `land`. */
  writeFront: (title: string, about: string) => void;
  /**
   * The session's staged answer as a file (under `<root>/session/`, never `manuscript/`), for a
   * caller that speaks HTTP and must send its text: `engine.mjs land <lease> --text <path>`.
   */
  stageFile: (n: number) => string;
  /** What the site serves for chapter `n`: the rows' canonical text, or null. */
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
  // BOOK-187: no `manuscript/` is created. A pass that needed one would fail here, not in prod.
  const manuscript = join(root, 'manuscript');
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
        const slot = nextDraftChapter(writtenChaptersOf(db), input.for);
        if (slot !== null) fileIfEmpty(slot);
      }
      return nextRaw(input);
    };
    const passRaw = engine.openChapterPass.bind(engine);
    engine.openChapterPass = (chapter, session) => {
      fileIfEmpty(chapter);
      return passRaw(chapter, session);
    };
  }

  /**
   * The rows of a chapter that exists before a pass — what the one-shot import leaves behind.
   * It goes through the real applier, so a seeded chapter has its revision and its snapshot,
   * which is what `--revert` and `blame` read. A chapter that carries the canon frame keeps it
   * (BOOK-137): the applier refuses a ch01/ch42 whose sentence moved, exactly as in production.
   */
  const seedChapter = (n: number, text: string): void => {
    applyChapterFile({
      db,
      dataDir,
      n,
      raw: withFrameText(n, text),
      mtimeMs: clock.now(),
      nowMs: clock.now(),
    });
  };
  const seedChapterBlocks = (n: number, title: string, blocks: string[]): void => {
    seedChapter(n, chapterText(title, withFrame(n, blocks)));
  };
  const seedFront = (title: string, about: string): void => {
    applyFrontFile({
      db,
      dataDir,
      raw: `${title}\n\n${about}\n`,
      mtimeMs: clock.now(),
      nowMs: clock.now(),
    });
  };

  /**
   * The scripted session's answer, held in memory: `land` carries it in the request, and no
   * file exists anywhere (BOOK-187). `writeChapter` is the old name, because a test says «the
   * session wrote this» either way.
   */
  const staged = { chapters: new Map<number, string>(), front: null as string | null };
  const writeChapter = (n: number, text: string): void => {
    staged.chapters.set(n, text);
  };
  /**
   * BOOK-137: the canon frame opens ch01 and closes ch42, so a chapter written by paragraph
   * carries it — the land guard refuses a landing that lets the sentence move, exactly as in
   * production. A test that needs an exact text (a basis-only slot, a broken frame) stages it
   * with `writeChapter`, which stays raw.
   */
  const writeChapterBlocks = (n: number, title: string, blocks: string[]): void => {
    writeChapter(n, chapterText(title, withFrame(n, blocks)));
  };
  const writeFront = (title: string, about: string): void => {
    staged.front = `${title}\n\n${about}\n`;
  };
  const stageFile = (n: number): string => {
    const dir = join(root, 'session');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `ch${String(n).padStart(2, '0')}.md`);
    writeFileSync(path, staged.chapters.get(n) ?? '', 'utf8');
    return path;
  };

  if (options.front !== null) {
    const front = options.front ?? { title: 'Без названия', about: DEFAULT_ABOUT };
    seedFront(front.title, front.about);
  }
  for (const [n, text] of Object.entries(options.chapters ?? {})) {
    seedChapter(Number(n), text);
  }

  // `land` is where the scripted session hands its text over: the fixture attaches what it
  // staged for that step's chapter, so a test still says «the session wrote it, then landed».
  const landRaw = engine.land.bind(engine);
  engine.land = (leaseId, options = {}) => {
    const target = db
      .prepare(
        `SELECT s.chapter AS chapter, s.pass AS pass FROM leases l JOIN steps s ON s.step_id = l.step_id
          WHERE l.id = ?`,
      )
      .get(leaseId) as { chapter: number | null; pass: string } | undefined;
    const chapter = target?.chapter ?? null;
    const forFront = target?.pass === 'front';
    const text = options.text ?? (chapter === null ? undefined : staged.chapters.get(chapter));
    const frontRaw = options.frontRaw ?? (forFront ? (staged.front ?? undefined) : undefined);
    return landRaw(leaseId, {
      ...options,
      ...(text === undefined ? {} : { text }),
      ...(frontRaw === undefined ? {} : { frontRaw }),
    });
  };

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
    seedChapter,
    seedChapterBlocks,
    seedFront,
    writeChapter,
    writeChapterBlocks,
    writeFront,
    stageFile,
    readChapter: (n) => {
      const rows = readChapterRows(db, n);
      return rows.exists ? rows.raw : null;
    },
    readFrontBlocks: () => readFrontRows(db).about ?? DEFAULT_ABOUT,
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

