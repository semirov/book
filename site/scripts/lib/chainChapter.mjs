/**
 * lib/chainChapter.mjs — a new chapter, written into the temp copy, printing on the one clock.
 *
 * BOOK-220 §11.2: «новая глава так же пишется». The engine's real path is a create revision
 * attributed to a step: the bridge publishes it as `chapter:applied` (rev 1, `appliedAt`), the
 * page fetches the prose and prints it from that moment — in a slot that already shows its
 * number and title. This module writes such a revision into the copy (the chapter row, its
 * blocks, the content-addressed snapshot, the row) and measures what the page does with it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { openDb, waitFrame } from './chainPrint.mjs';

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);
/** The device's rate, the same two numbers the engine prints at. */
const DESK_CPS = 30;
const PHONE_CPS = 26;
/** The graphemes one sample has on screen. */
const charsOf = (state) => (state?.widths ?? []).reduce((sum, width) => sum + Math.max(0, width), 0);

/**
 * The first chapter the copy still serves as unwritten (`rev = 0`): the slot the print will
 * fill. `exclude` keeps the chapter another run is measuring out of the way.
 */
export function unwrittenChapter(dir, exclude) {
  const db = openDb(dir);
  try {
    // A chapter is written when its projection row says so — this volume keeps no row at all
    // for a chapter the book has not reached yet, and the frame chapters (1, 42) are not slots.
    const written = new Set(
      db
        .prepare('SELECT n FROM chapters WHERE rev > 0 OR basis = 1 OR block_count > 0')
        .all()
        .map((row) => row.n),
    );
    const logged = new Set(db.prepare('SELECT DISTINCT chapter FROM revisions').all().map((row) => row.chapter));
    for (let n = 2; n <= 41; n += 1) {
      if (n === exclude || written.has(n) || logged.has(n)) continue;
      return n;
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * One create in one transaction: the snapshot, the chapter row, its blocks and the `revisions`
 * row (`kind = 'create'`, rev 1, the step that wrote it). Nothing outside `dir` is touched.
 */
export function writeNewChapter({ dir, chapter, text, at, stepId, parseChapter }) {
  if (typeof parseChapter !== 'function') throw new Error('writeNewChapter needs the parser');
  const parsed = parseChapter(chapter, text);
  const snapshot = join('versions', `ch${String(chapter).padStart(2, '0')}`, `${parsed.sha256}.md`);
  mkdirSync(dirname(join(dir, 'data', snapshot)), { recursive: true });
  writeFileSync(join(dir, 'data', snapshot), text, 'utf8');
  const atIso = new Date(at).toISOString();
  const title = text.split('\n')[0] ?? null;

  const db = openDb(dir);
  try {
    db.exec('BEGIN IMMEDIATE');
    // The next revision of this chapter: rev 1 for a slot that was never written, and the one
    // after the last row for an emptied one (the frame is a write either way).
    const lastRev =
      db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM revisions WHERE chapter = ?').get(chapter)?.rev ?? 0;
    const rev = lastRev + 1;
    // The chapter row first: `blocks` and `revisions` are foreign-keyed to it.
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(n) DO UPDATE SET
         rev = excluded.rev, title = excluded.title, sha256 = excluded.sha256, chars = excluded.chars,
         block_count = excluded.block_count, basis = 0,
         written_at = COALESCE(chapters.written_at, excluded.written_at), updated_at = excluded.updated_at`,
    ).run(chapter, rev, title, parsed.sha256, parsed.chars, parsed.blocks.length, atIso, atIso);
    db.prepare('DELETE FROM blocks WHERE chapter = ?').run(chapter);
    const insertBlock = db.prepare(
      'INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const block of parsed.blocks) {
      insertBlock.run(block.id, chapter, block.i, block.text, block.hash, rev, rev);
    }
    db.prepare(`INSERT INTO revisions
        (chapter, rev, at, kind, cause_kind, change_id, cascade_id, step_id, added, changed, removed,
         snapshot, attributed, hseq)
        VALUES (?, ?, ?, 'create', 'change', NULL, NULL, ?, ?, 0, 0, ?, 1, NULL)`).run(
      chapter,
      rev,
      atIso,
      stepId,
      parsed.blocks.length,
      snapshot,
    );
    db.exec('COMMIT');
    return { rev, at, atIso, snapshot, chars: parsed.chars, blocks: parsed.blocks.length, title };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    throw error;
  } finally {
    db.close();
  }
}

/** One in-page reading of the slot the print fills: its head, its title, its blocks' ink. */
export const REVEAL_SOURCE = String.raw`
(chapter) => {
  const article = document.getElementById('ch-' + chapter);
  if (article === null) return { found: false, t: Date.now() };
  const blocks = Array.from(article.querySelectorAll('p[data-block-id]'));
  const title = article.querySelector('.ch-title');
  const numeral = article.querySelector('.ch-n');
  return {
    found: true,
    t: Date.now(),
    numeral: numeral === null ? null : (numeral.textContent || ''),
    title: title === null ? null : (title.textContent || ''),
    // Bit 4 of compareDocumentPosition: the prose *precedes* the title when set.
    titleBeforeProse:
      title === null || blocks.length === 0
        ? null
        : (blocks[0].compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
    skeleton: article.querySelectorAll('.skel, .skel-line').length,
    placeholder: article.querySelectorAll('.ch-placeholder').length,
    widths: blocks.map((block) => Number(block.getAttribute('data-chars') ?? '-1')),
    carets: article.querySelectorAll('.caret-inline').length,
    pass: article.classList.contains('is-printing'),
    // The reveal's own clock, published by the hook (window.__reveal): its zero, its first
    // grapheme's instant and its end. Absent once the print is over.
    plan: (() => {
      const plan = globalThis.__reveal;
      if (!plan || plan.n !== chapter) return null;
      return { startAt: plan.startAt, firstInkMs: plan.firstInkMs, totalMs: plan.totalMs, blocks: plan.blocks };
    })(),
  };
}`;

/**
 * BOOK-220 §11.2 — «новая глава так же пишется»: a chapter created by a step prints from its
 * first character on the one clock, in a slot that already shows its number and title.
 *
 * The write is the engine's own shape: a `create` revision attributed to a step, so the bridge
 * publishes `chapter:applied` (rev 1) and the page prints the prose from `appliedAt`. What is
 * measured: the slot's head before the ink, a monotone reveal from 0, one caret, the title ahead
 * of the prose, the effective rate, and the final text the API serves.
 */
export async function newChapter({ cdp, run, dir, stepId, check, log, shot, parseChapter }) {
  const chapter = unwrittenChapter(dir, run.chapter);
  if (chapter === null) return null;
  const sentence =
    'Новая глава начинается с этой строки и пишется знак за знаком, пока не кончится воздух в лёгких, ' +
    'а потом начинается вторая строка, и в ней уже нечего добавить, кроме последнего слова.';
  const text = `Новая глава\n\n${sentence}`;
  const evaluate = async (expression) => {
    const answer = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    return answer.result.value;
  };
  // A fresh page at the slot: the previous stage left this one mid-print, and a list of 42
  // slots is what the create needs (the chapter has no prose yet, only its row).
  await cdp.send('Page.navigate', { url: `${String(run.api)}/#ch-${String(chapter)}` });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const count = await evaluate(`document.querySelectorAll('article.ch').length`);
    if (typeof count === 'number' && count >= 40) break;
    await sleep(100);
  }
  await sleep(400);
  // The slot loads its prose near the viewport: bring it there before the write lands.
  await evaluate(
    `document.getElementById('ch-${String(chapter)}')?.scrollIntoView({ block: 'center', behavior: 'instant' }) ?? null`,
  );
  await sleep(300);
  const before = await evaluate(`(${REVEAL_SOURCE})(${String(chapter)})`);
  const write = writeNewChapter({ dir, chapter, text, at: Date.now(), stepId, parseChapter });
  const frame = await waitFrame(cdp, write.rev, 8_000);
  const samples = [];
  let image = null;
  const started = Date.now();
  for (;;) {
    const state = await evaluate(`(${REVEAL_SOURCE})(${String(chapter)})`);
    samples.push(state);
    if (image === null && state.found === true && (state.widths[0] ?? 0) > 2) {
      image = await shot(`${String(run.width)}-new-chapter`);
    }
    const done =
      state.found === true && state.carets === 0 && samples.length > 3 &&
      state.widths.length > 0 && state.widths.every((width) => width > 0);
    if (done || Date.now() - started > 30_000) break;
    await sleep(100);
  }
  const served = await (await fetch(`${String(run.api)}/api/chapters/${String(chapter)}`)).json();
  const printed = samples.filter((state) => state.found === true && state.widths.some((width) => width > 0));
  const first = printed[0] ?? null;
  /** The slot's head as it stands in the print's first frame: numeral, title, no bars. */
  const head = samples.find((state) => state.found === true && state.title !== null) ?? null;
  const last = printed.at(-1) ?? null;
  const monotone = samples.every((state, index) => {
    if (state.found !== true) return true;
    const earlier = samples[index - 1];
    if (earlier === undefined || earlier.found !== true) return true;
    return state.widths.every((width, at) => width >= (earlier.widths[at] ?? -1));
  });
  const domIds = await evaluate(
    `Array.from(document.querySelectorAll('#ch-${String(chapter)} p[data-block-id]')).map((node) => node.getAttribute('data-block-id'))`,
  );
  const full = last !== null && last.widths.every((width, at) => width === (served.blocks[at]?.text.length ?? -1));
  // Content-addressed: the block's id is `ch<nn>#<sha1(text)[0,8]>`, so equal ids are equal text
  // hashes — the printed block *is* the revision the API serves.
  const prefix = `ch${String(chapter).padStart(2, '0')}#`;
  const hashes = domIds.every((id, at) => id === `${prefix}${served.blocks[at]?.hash ?? ''}`);
  const carets = samples.filter((state) => state.found === true).map((state) => state.carets);
  /** The reveal's own plan: its zero must be the write's moment, not a mount time. */
  const plan = samples.map((state) => state.plan ?? null).find((value) => value !== null) ?? null;
  const baseCps = run.width < 600 ? PHONE_CPS : DESK_CPS;
  // How many graphemes the clock could have inked by the first observation: base rate × the
  // time since `appliedAt`, rounded up, +2 for the sample's own jitter. Pauses and hesitations
  // only ever make the real count smaller, so this is a ceiling, not a target.
  const observedMs = first === null ? null : first.t - write.at;
  const clockChars = observedMs === null ? null : Math.ceil((baseCps * observedMs) / 1_000) + 2;
  const firstChars = first?.widths[0] ?? null;
  const delta = firstChars === null || clockChars === null ? null : firstChars - clockChars;
  const grew = first !== null && last !== null && last.t > first.t && charsOf(last) > charsOf(first);
  const ms = first === null || last === null ? null : last.t - first.t;
  const chars = last === null ? 0 : last.widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  const cps = ms === null || ms <= 0 ? null : (chars / ms) * 1_000;
  log(
    `${String(run.width)}: chapter ${String(chapter)} prints — ${String(chars)} chars in ` +
      `${String(ms === null ? '?' : (ms / 1_000).toFixed(1))} s (${String(round(cps))} cps effective), ` +
      `${String(samples.length)} samples`,
  );
  check(
    `chapter/${String(run.width)} the plan's zero is appliedAt, and the first reveal is only what that clock could have inked`,
    before.found === true && frame !== null && plan !== null && plan.startAt === write.at &&
      plan.firstInkMs !== null && plan.firstInkMs >= plan.startAt &&
      firstChars !== null && firstChars > 0 && clockChars !== null && firstChars <= clockChars &&
      grew === true && monotone === true && full === true && hashes === true &&
      cps !== null && cps > 20 && cps < 40,
    `plan zero = appliedAt (${String(plan?.startAt === write.at)}), first ink +${String(plan?.firstInkMs === null || plan === null ? '?' : plan.firstInkMs - plan.startAt)} ms; ` +
      `first sample ${String(firstChars)} chars at +${String(observedMs === null ? '?' : observedMs)} ms, ` +
      `clock ceiling ${String(clockChars)} → delta ${String(delta)}; ` +
      `${String(chars)} chars over ${String(ms === null ? '?' : (ms / 1_000).toFixed(1))} s → ${String(round(cps))} cps; ` +
      `monotone ${String(monotone)}, ends on the served text ${String(full)}, block hashes ${String(hashes)}`,
  );
  check(
    `chapter/${String(run.width)} the slot shows «глава N» and the title with no skeleton`,
    head !== null && /^\d{1,2}$/u.test(String(head.numeral)) && head.title === write.title &&
      head.skeleton === 0 && samples.every((state) => state.found !== true || state.skeleton === 0),
    `numeral «${String(head?.numeral)}», title «${String(head?.title)}», skeleton ${String(head?.skeleton)}; ` +
      `the empty slot before the write: «${String(before.numeral)}», ${String(before.skeleton)} bars`,
  );
  check(
    `chapter/${String(run.width)} the title stands ahead of the prose, and one caret prints the text`,
    samples.every((state) => state.found !== true || state.titleBeforeProse !== false) &&
      carets.every((count) => count <= 1) &&
      printed.filter((state) => state.widths[0] < (last?.widths[0] ?? 0)).every((state) => state.carets === 1),
    `title-before-prose on ${String(samples.filter((state) => state.titleBeforeProse === true).length)} samples, ` +
      `max carets ${String(Math.max(0, ...carets))}`,
  );
  // A fresh page for the next stage: the catalog this one holds was read before the create, so
  // the folio cannot name a page while the reader stands in a chapter it has never heard of.
  await cdp.send('Page.navigate', { url: `${String(run.api)}/#ch-${String(run.chapter)}` });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await evaluate(`document.querySelectorAll('article.ch').length > 0`);
    if (ready === true) break;
    await sleep(100);
  }
  await sleep(500);
  return {
    chapter,
    rev: write.rev,
    frameAt: frame?.t ?? null,
    blocks: served.blocks.length,
    chars,
    ms,
    cps: round(cps),
    samples: samples.length,
    before: { numeral: before.numeral, title: before.title, skeleton: before.skeleton, ink: before.widths },
    firstWidths: first?.widths ?? null,
    lastWidths: last?.widths ?? null,
    monotone,
    full,
    hashes,
    plan: plan === null ? null : { startAt: plan.startAt, firstInkMs: plan.firstInkMs, appliedAt: write.at },
    firstSample: { chars: firstChars, atMs: observedMs, clockChars, delta },
    shot: image,
  };
}
