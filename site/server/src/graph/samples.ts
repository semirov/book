/**
 * Ten extraction decisions, quoted (BOOK-185).
 *
 * The point of a sample is to be read against the prose: a chapter, a kind, the key, the sentence
 * it came from and the exact span the mention covers, so a person can say «this is right» or
 * «this is wrong» without opening the database. Since the model reads and code checks
 * (BOOK-DOC-77 §5), a sample also names **what produced it** — the run id, the model and the
 * prompt sha read back from `facts.extracted_by` — because a wrong fact is only actionable if the
 * prompt version it came from is known.
 *
 * The selection is **deterministic and spread**: kinds take turns in a fixed order, and within a
 * kind a chapter that has not been quoted yet is preferred — the same database always yields the
 * same ten, and a re-run cannot make the sample look better by luck.
 */

import type { Db } from '../db/db.ts';
import { FACT_KINDS } from '../db/ledgerTables.ts';

export type Sample = {
  chapter: number;
  kind: string;
  key: string;
  term: string;
  quote: string;
  witness: string;
  blockId: string;
  spanId: string;
  start: number;
  end: number;
  /** The run whose answer wrote this fact (`facts.extracted_by`). */
  run: string;
  model: string;
  promptSha: string;
  /** The pass that first produced it: `extract` or `recall`, read from the same stamp. */
  pass: string;
};

type FactRow = {
  id: string;
  chapter: number;
  kind: string;
  key: string;
  term: string | null;
  sentence: string;
  extracted_by: string;
};

/** `{run, model, prompt, at, pass}` as `persistFacts.stampOf` writes it; blanks when absent. */
function stampOf(raw: string): { run: string; model: string; promptSha: string; pass: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      run: typeof parsed.run === 'string' ? parsed.run : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      promptSha: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      pass: typeof parsed.pass === 'string' ? parsed.pass : '',
    };
  } catch {
    return { run: '', model: '', promptSha: '', pass: '' };
  }
}

/** The carrier order the kinds take turns in: the seven carriers the pass returns. */
const ORDER: readonly string[] = FACT_KINDS;

export function buildSamples(db: Db, limit: number): Sample[] {
  // A fact nobody mentions cannot be shown with offsets, so it is not a sample: the quote would
  // be the only evidence, and the point of a sample is the span.
  const mentioned = db
    .prepare(
      `SELECT fact_id, block_id, span_id, start, end, witness FROM mentions
        WHERE fact_id IS NOT NULL AND kind = 'fact'
        ORDER BY CASE role WHEN 'assert' THEN 0 ELSE 1 END, chapter, id`,
    )
    .all() as Array<{ fact_id: string; block_id: string; span_id: string; start: number; end: number; witness: string }>;
  const mentionOf = new Map<string, (typeof mentioned)[number]>();
  for (const row of mentioned) if (!mentionOf.has(row.fact_id)) mentionOf.set(row.fact_id, row);

  const facts = (
    db
      .prepare(
        `SELECT id, chapter, kind, key, term, sentence, extracted_by FROM facts
          WHERE key <> '' AND invalidated_at IS NULL AND superseded_by_extraction IS NULL
          ORDER BY chapter, key`,
      )
      .all() as FactRow[]
  ).filter((fact) => mentionOf.has(fact.id));
  const byKind = new Map<string, FactRow[]>();
  for (const fact of facts) {
    const list = byKind.get(fact.kind) ?? [];
    list.push(fact);
    byKind.set(fact.kind, list);
  }

  const picked: FactRow[] = [];
  const seen = new Set<string>();
  const usedChapters = new Set<number>();
  while (picked.length < limit) {
    let progressed = false;
    for (const kind of ORDER) {
      if (picked.length >= limit) break;
      const pool = (byKind.get(kind) ?? []).filter((fact) => !seen.has(fact.id));
      const pick = pool.find((fact) => !usedChapters.has(fact.chapter)) ?? pool[0];
      if (pick === undefined) continue;
      picked.push(pick);
      seen.add(pick.id);
      usedChapters.add(pick.chapter);
      progressed = true;
    }
    if (!progressed) break;
  }

  return picked.map((fact) => {
    const row = mentionOf.get(fact.id);
    const stamp = stampOf(fact.extracted_by);
    return {
      chapter: fact.chapter,
      kind: fact.kind,
      key: fact.key,
      term: fact.term ?? '',
      quote: fact.sentence,
      witness: row?.witness ?? '',
      blockId: row?.block_id ?? '',
      spanId: row?.span_id ?? '',
      start: row?.start ?? -1,
      end: row?.end ?? -1,
      run: stamp.run,
      model: stamp.model,
      promptSha: stamp.promptSha,
      pass: stamp.pass,
    };
  });
}
