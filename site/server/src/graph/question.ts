/**
 * The question one chapter asks (BOOK-185, BOOK-DOC-77 §2, §5).
 *
 * The prompt is part of a run's identity, so it is built here by one function and nobody else: the
 * pass asks this chapter's question (`extract.ts`), and the CLI's `--pending` asks whether that
 * same question has been answered. Two readers that built slightly different prompts would call a
 * chapter unfinished forever.
 *
 * What goes into the prompt is **retrieved, not trusted**: the earlier facts whose term or key
 * value appears in this chapter (`establishedFor`, capped and ordered so two runs see the same
 * list) and the threads the book followed before it, at the state they had before it
 * (`threadHintsOf`). Retrieval is code's job; meaning is the model's.
 */

import type { Db } from '../db/db.ts';
import { getChapterRow, listBlocks } from '../db/repo/chapters.ts';
import { replayThread } from './persistThreads.ts';
import { buildExtractPrompt, ESTABLISHED_LIMIT, THREADS_LIMIT, type ExtractPrompt } from './prompt.ts';
import type { Question } from './runs.ts';
import { normalise } from './text.ts';
import type { Block, EstablishedFact, ThreadHint } from './validate.ts';

export type LiveFact = { id: string; key: string; kind: EstablishedFact['kind']; chapter: number; term: string | null };

/** `document:65-11877-арх` → `65-11877-арх`: the half of a key a chapter may literally contain. */
function keyValueOf(key: string): string {
  const at = key.indexOf(':');
  return at === -1 ? key : key.slice(at + 1);
}

/**
 * The earlier facts this chapter may be **using**: live, established before it, and named by term
 * or by key value somewhere in the text. Retrieval, not trust — a list of the whole graph would
 * bury the two or three facts the chapter actually speaks of. Ordered by chapter then key, capped,
 * so two runs of one chapter are shown the same list.
 */
function establishedFor(db: Db, chapter: number, text: string): LiveFact[] {
  const rows = db
    .prepare(
      `SELECT id, key, kind, chapter, term FROM facts
        WHERE chapter < ? AND invalidated_at IS NULL AND superseded_by_extraction IS NULL AND key <> ''
        ORDER BY chapter, key`,
    )
    .all(chapter) as LiveFact[];
  const haystack = normalise(text);
  const found: LiveFact[] = [];
  for (const row of rows) {
    const term = normalise(row.term ?? '');
    const value = normalise(keyValueOf(row.key));
    if ((term === '' || !haystack.includes(term)) && (value === '' || !haystack.includes(value))) continue;
    found.push(row);
    if (found.length >= ESTABLISHED_LIMIT) break;
  }
  return found;
}

/**
 * The threads a chapter may move: the ones the book was following **before** it, with the state
 * they had **before** it.
 *
 * Two reasons for the as-of replay instead of the row's `state`. A hint is a fact about chapter
 * N-1 — the same world `establishedFor` reads — and a thread the answer itself opened or closed
 * in chapter N must not change the question chapter N is asked (the prompt is part of the run's
 * identity, so a prompt that moved under its own answer could never be reused). And the validator
 * needs the state the move starts from, which is the pre-N one: a thread closed at chapter N is
 * still open to the answer that closes it.
 */
export function threadHintsOf(db: Db, chapter: number): ThreadHint[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.label, t.opened_at_chapter AS openedAt, e.chapter AS eventChapter, e.kind AS eventKind
         FROM threads t
         LEFT JOIN thread_events e ON e.thread_id = t.id AND e.chapter < ?
        ORDER BY t.opened_at_chapter, t.id, e.chapter, e.id`,
    )
    .all(chapter) as Array<{
    id: string;
    label: string;
    openedAt: number;
    eventChapter: number | null;
    eventKind: string | null;
  }>;
  const byThread = new Map<string, { id: string; label: string; events: Array<{ chapter: number; kind: string }> }>();
  for (const row of rows) {
    const entry = byThread.get(row.id) ?? { id: row.id, label: row.label, events: [] };
    if (row.eventChapter !== null && row.eventKind !== null) {
      entry.events.push({ chapter: row.eventChapter, kind: row.eventKind });
    }
    byThread.set(row.id, entry);
  }
  const hints: ThreadHint[] = [];
  for (const entry of byThread.values()) {
    // No event before this chapter: the thread did not exist yet, so the answer may open it.
    if (entry.events.length === 0) continue;
    const { state } = replayThread(entry.events);
    if (state === 'closed') continue;
    hints.push({ id: entry.id, label: entry.label, state });
    if (hints.length >= THREADS_LIMIT) break;
  }
  return hints;
}

// ---------------------------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------------------------

/** One chapter as the question is built from it: what was read, what the prompt says, what it is. */
export type PreparedChapter = {
  chapter: number;
  rev: number;
  textSha: string;
  blocks: Block[];
  text: string;
  established: EstablishedFact[];
  threads: ThreadHint[];
  prompt: ExtractPrompt;
  system: string;
  user: string;
  model: string;
  question: Question;
};

/**
 * Read the chapter and name the question it asks. Both the pass and the CLI's `--pending` need
 * the same tuple — a pending list computed from a second, slightly different prompt would call a
 * chapter unfinished forever. Throws only when the chapter is not in the book at all.
 */
export function prepareChapter(db: Db, chapter: number, model: string): PreparedChapter {
  const chapterRow = getChapterRow(db, chapter);
  if (chapterRow === undefined) throw new Error(`graph: chapter ${String(chapter)} is not in the book`);

  const blocks: Block[] = listBlocks(db, chapter).map((block) => ({ id: block.id, text: block.text }));
  const text = blocks.map((block) => block.text).join('\n\n');
  const established: EstablishedFact[] = establishedFor(db, chapter, text).map((row) => ({
    id: row.id,
    key: row.key,
    kind: row.kind,
    chapter: row.chapter,
    term: row.term ?? '',
  }));
  const threads = threadHintsOf(db, chapter);
  const prompt = buildExtractPrompt({
    chapter,
    text,
    established: established.map((fact) => ({ key: fact.key, kind: fact.kind, term: fact.term, chapter: fact.chapter })),
    threads: threads.map((thread) => ({ label: thread.label, state: thread.state })),
  });
  return {
    chapter,
    rev: chapterRow.rev,
    textSha: chapterRow.sha256,
    blocks,
    text,
    established,
    threads,
    prompt,
    system: prompt.messages[0]?.content ?? '',
    user: prompt.messages[1]?.content ?? '',
    model,
    question: {
      chapter,
      rev: chapterRow.rev,
      textSha: chapterRow.sha256,
      promptSha: prompt.sha,
      model,
      pass: 'extract',
    },
  };
}

