/**
 * Gate and role prompts, taken verbatim from `process/ROLE_PROMPTS.md` (ADR-038 §5).
 *
 * The lane never paraphrases, never appends and never invents: a prompt is the body of the
 * **first** ```text fenced block of a section, byte-for-byte between the fences. A section is
 * matched by heading prefix (`0`, `0a`, `0b`, `1`, `2`, `3`), so `0a.` never collides with `0.`.
 *
 * Today `0a` (gate A) and `0b` (gate B) do not exist — BOOK-61 owns them. Their rows are
 * reported `blocked: prompt section missing: 0a (BOOK-61)`, counted, and never mocked. That is
 * the honest headline of BOOK-62, not a defect of the lane.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BOOK_ROOT, LaneError } from './pipeline.mjs';

export const PROMPTS_PATH = join(BOOK_ROOT, 'process', 'ROLE_PROMPTS.md');

/** Gate → section id, and role → section id (§5 of the ADR; `0` is the auditor/adequacy gate). */
export const SECTION_OF_GATE = { A: '0a', B: '0b', C: '0' };
export const SECTION_OF_ROLE = { writer: '1', editor: '2', consultant: '3' };

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * A section: its heading, the section text (heading to the next `## `, minus the last newline).
 *
 * A heading is a `## ` line **outside** a fenced block: §1, §2 and §3 each carry `## …`
 * sub-headings inside their own prompt, and splitting on them would cut every prompt in half.
 */
function sectionsOf(source) {
  const lines = source.split('\n');
  const sections = [];
  let current = null;
  let fenced = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) {
      if (current !== null) sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [line] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) sections.push(current);
  return sections;
}

/** The first ```text block of a section body, byte-for-byte; `null` when the section has none. */
function firstTextBlock(lines) {
  const open = lines.findIndex((line) => line.trim() === '```text');
  if (open === -1) return null;
  const close = lines.findIndex((line, index) => index > open && line.trim() === '```');
  if (close === -1) return null;
  return lines.slice(open + 1, close).join('\n');
}

/**
 * Resolve one section by heading prefix. Returns the prompt and both hashes, or a `blocked`
 * reason with the exact string the evidence and the summary use.
 */
export function resolveSection(source, id) {
  const section = sectionsOf(source).find((candidate) => candidate.heading.startsWith(`${id}.`));
  if (section === undefined) return { ok: false, id, reason: `prompt section missing: ${id} (BOOK-61)` };
  const prompt = firstTextBlock(section.lines);
  if (prompt === null || prompt.trim().length === 0) {
    return { ok: false, id, reason: `prompt section malformed: ${id}` };
  }
  // The trailing newline of a section is not content: the last line before the next heading
  // usually is blank, and a reader re-hashing the file must get the same number.
  const sectionText = section.lines.join('\n').replace(/\n+$/u, '');
  return {
    ok: true,
    id,
    heading: section.heading,
    prompt,
    sectionSha256: sha256(sectionText),
    promptSha256: sha256(prompt),
  };
}

/** All six sections in one read, so a run cannot see two versions of the file. */
export function resolvePrompts(path = PROMPTS_PATH) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new LaneError('PROMPTS_UNREADABLE', `cannot read ${path}`);
  }
  const sections = {};
  for (const id of ['0', '0a', '0b', '1', '2', '3']) sections[id] = resolveSection(source, id);
  return sections;
}

/** The heading of the block §4 calls «the invariants» — every role's brief starts with it. */
const INVARIANTS_HEADING = 'Invariants';

/**
 * `## Invariants — every role`: from its heading up to the next `## ` outside a fence, verbatim.
 * §4 of the brief is explicit — «brief = the invariants, §1 verbatim, the lane and the slot» —
 * so a pass that sends only the role section is a different prompt than prod's.
 */
export function resolveInvariants(path = PROMPTS_PATH) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new LaneError('PROMPTS_UNREADABLE', `cannot read ${path}`);
  }
  const section = sectionsOf(source).find((candidate) => candidate.heading.startsWith(INVARIANTS_HEADING));
  if (section === undefined) {
    return { ok: false, heading: null, text: '', sha256: null, reason: `prompt section missing: ${INVARIANTS_HEADING} (BOOK-62)` };
  }
  const text = section.lines.join('\n').replace(/\n+$/u, '');
  if (text.trim().length === 0) {
    return { ok: false, heading: section.heading, text: '', sha256: null, reason: `prompt section malformed: ${INVARIANTS_HEADING}` };
  }
  return { ok: true, heading: section.heading, text, sha256: sha256(text), reason: null };
}

// ── the three turns the lane sends ───────────────────────────────────────────────────────────
// What goes on the wire is prompt work, so it lives here with the file it reads, not in the pass.

/** The four canon files the writer is given (§1 of the brief: "the four canon files"). */
const CANON = ['concept/CONCEPT.md', 'concept/CLIMAX.md', 'style/VOICE.md', 'outline/PLAN.md'];
/** `shared/src/book.ts` — the forward lane the pass writes in ends here. */
const FORWARD_LAST = 34;
const CHAPTER_FILE = /^ch(\d{2})\.md$/u;

/** One message per file, so the model reads the same names a session reads. */
function fileBlock(relative, text) {
  return `# ${relative}\n\n${text.trim()}\n`;
}

/** The scratch book's chapters in the forward lane, minus the slot being written. */
function laneChapters(bookRoot, target) {
  const dir = join(bookRoot, 'manuscript');
  const chapters = [];
  for (const name of readdirSync(dir).sort()) {
    const match = CHAPTER_FILE.exec(name);
    if (match === null) continue;
    const n = Number(match[1]);
    if (n === target || n > FORWARD_LAST) continue;
    const text = readFileSync(join(dir, name), 'utf8').trim();
    if (text.length === 0) continue;
    chapters.push({ name, n, text });
  }
  return chapters;
}

/**
 * The system turn: «the invariants, §1 verbatim» (ROLE_PROMPTS §4) — the invariants block first,
 * then the role's own section byte-for-byte. Nothing is appended after the section: §5 of the ADR
 * forbids touching prompt text, and a second sentence here would be an instruction region prod
 * does not have.
 */
export function systemTurn(invariants, section) {
  return { role: 'system', content: `${invariants.text}\n\n${section.prompt}` };
}

export function writerMessages(bookRoot, invariants, prompts, assignment) {
  const canon = CANON.map((relative) => fileBlock(relative, readFileSync(join(bookRoot, relative), 'utf8')));
  const chapters = laneChapters(bookRoot, assignment.chapter).map((chapter) =>
    fileBlock(`manuscript/${chapter.name}`, chapter.text),
  );
  const body = [
    ...canon,
    ...chapters,
    `# assignment\n\n${JSON.stringify(assignment, null, 2)}\n`,
  ].join('\n');
  return [systemTurn(invariants, prompts[SECTION_OF_ROLE.writer]), { role: 'user', content: body }];
}

export function gateMessages(invariants, prompts, role, assignment, text) {
  const slicePath = assignment.indexSlice;
  const slice =
    typeof slicePath === 'string' && slicePath.length > 0
      ? JSON.parse(readFileSync(slicePath, 'utf8'))
      : null;
  const body = { assignment, text, ...(slice === null ? {} : { indexSlice: slice }) };
  return [systemTurn(invariants, prompts[SECTION_OF_ROLE[role]]), { role: 'user', content: JSON.stringify(body, null, 2) }];
}
