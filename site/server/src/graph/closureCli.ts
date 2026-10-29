/**
 * `graph closure` and `graph bench` (BOOK-174, ADR-040 §3–§4): what a filing moves, what it
 * costs, and whether the walk keeps its 25 ms budget.
 *
 * The command prints the **whole** closure — every mandatory node with the edge that makes it
 * mandatory, every optional node with the support that keeps it true — because the value of an
 * unbounded discovery is that a person can see all of it. Nothing here decides whether a node is
 * false: `mandatoryOf` applies the mechanical rule, and the editor's sentence stays the editor's.
 *
 * `--chapter N --quote "…"` resolves the quote to facts through the chapter's mentions and the
 * facts' own sentences, normalised: a document number written `65/11877/арх` and printed
 * `65-11877-арх` are one key and one fact. A quote that resolves to nothing is a **finding**, not
 * an error: the command prints «no fact in this sentence», shows up to three fact mentions that
 * are actually there, and exits 0 — an operator who reads «no fact» should not also have to read
 * a stack trace.
 *
 * `--apply <chapters|all>` says which chapters the plan will actually execute. It is the default
 * `all` that matches the engine (the origin for `local`, every priced chapter otherwise); a list
 * is a narrower answer, and a mandatory node outside it is refused with `CAUSE_MISSING` — a
 * mandatory node is never deferred (§4.2).
 */

import type { Db } from '../db/db.ts';
import { openGraphDb, parseFlags } from './cliArgs.ts';
import { bench, closure, mandatoryOf } from './closure.ts';
import { decide, type ModeInput } from './modes.ts';
import { pluralEn } from './plural.ts';
import { normalise } from './text.ts';
import type { GraphIo } from './cli.ts';

type FactHit = {
  factId: string;
  key: string;
  kind: string;
  chapter: number;
  sentence: string;
  witness: string;
  /** Code point offset of the witness in its block; -1 for a fact matched only by its sentence. */
  start: number;
};

/**
 * The key normalisation plus separator folding: a paper printed `65/11877/арх` and keyed
 * `65-11877-арх` is one paper (the same fold `referenceLiteral` makes), and a typographic dash is
 * a hyphen.
 */
function foldQuote(text: string): string {
  return normalise(text)
    .replace(/[\/\\–—]/gu, '-')
    .replace(/-+/gu, '-');
}

function chapterOfFact(db: Db, factId: string): number | null {
  const row = db.prepare(`SELECT chapter FROM facts WHERE id = ?`).get(factId) as { chapter: number } | undefined;
  return row?.chapter ?? null;
}

/**
 * Every fact of this chapter that the quote names, in **three directions**, because the owner
 * pastes evidence and not keys:
 *
 * 1. the stored sentence contains the quote — a phrase quoted from the book;
 * 2. the quote contains the fact's witness — a pasted list («12.02, 15.02») names every date in
 *    it, and each of them is a seed;
 * 3. the witness contains the quote — a partial paste («11877» for «65/11877/арх»).
 *
 * A `use` mention in chapter N can name a fact established in chapter 3, so the mention's chapter,
 * not the fact's, is what makes a fact «in this sentence». Results are deduped per fact (the
 * first mention wins, so the offset is the earliest) and ordered by chapter, offset, key — the
 * order a reader reads the paragraph in.
 */
export function factsMatchingQuote(db: Db, chapter: number, quote: string): FactHit[] {
  const wanted = foldQuote(quote);
  if (wanted === '') return [];
  const rows = db
    .prepare(
      `SELECT m.fact_id AS factId, m.witness AS witness, m.start AS start,
              f.key AS key, f.kind AS kind, f.chapter AS chapter, f.sentence AS sentence
         FROM mentions m JOIN facts f ON f.id = m.fact_id
        WHERE m.chapter = ? AND m.kind = 'fact' AND m.fact_id IS NOT NULL
        ORDER BY m.block_id, m.start, m.id`,
    )
    .all(chapter) as FactHit[];
  const hits = new Map<string, FactHit>();
  for (const row of rows) {
    if (hits.has(row.factId)) continue;
    if (quoteMatches(wanted, foldQuote(row.witness), foldQuote(row.sentence))) hits.set(row.factId, row);
  }
  // A fact asserted here with no mention at all is still in the sentence: the sentence is stored
  // on the fact itself, and a legacy row may have neither.
  const asserted = db
    .prepare(
      `SELECT id AS factId, key, kind, chapter, sentence FROM facts
        WHERE chapter = ? AND invalidated_at IS NULL ORDER BY id`,
    )
    .all(chapter) as Array<Omit<FactHit, 'witness' | 'start'>>;
  for (const row of asserted) {
    if (hits.has(row.factId)) continue;
    if (foldQuote(row.sentence).includes(wanted)) {
      hits.set(row.factId, { ...row, witness: row.sentence, start: -1 });
    }
  }
  return [...hits.values()].sort(
    (left, right) =>
      left.chapter - right.chapter ||
      left.start - right.start ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
}

/** The three directions of one match, on already-folded strings. */
function quoteMatches(quote: string, witness: string, sentence: string): boolean {
  if (sentence.includes(quote)) return true;
  // An empty witness would make `quote.includes('')` true for every quote, so it is excluded.
  if (witness === '') return false;
  return witness.includes(quote) || quote.includes(witness);
}

/** Up to three fact mentions of the chapter — the nearest to the quote when its block is known. */
function nearbyMentions(db: Db, chapter: number, quote: string): Array<{ factId: string; key: string; witness: string }> {
  const rows = db
    .prepare(
      `SELECT m.fact_id AS factId, m.witness AS witness, m.block_id AS blockId, m.start AS start, f.key AS key
         FROM mentions m JOIN facts f ON f.id = m.fact_id
        WHERE m.chapter = ? AND m.kind = 'fact' AND m.fact_id IS NOT NULL
        ORDER BY m.block_id, m.start, m.id`,
    )
    .all(chapter) as Array<{ factId: string; witness: string; blockId: string; start: number; key: string }>;
  const wanted = foldQuote(quote);
  const blockText = db.prepare(`SELECT text FROM blocks WHERE id = ?`);
  let anchor: { blockId: string; start: number } | null = null;
  for (const row of rows) {
    const block = blockText.get(row.blockId) as { text: string } | undefined;
    if (block === undefined) continue;
    const at = foldQuote(block.text).indexOf(wanted);
    if (at >= 0) {
      anchor = { blockId: row.blockId, start: at };
      break;
    }
  }
  const scored = rows.map((row, index) => ({
    row,
    score: anchor === null ? index : row.blockId === anchor.blockId ? Math.abs(row.start - anchor.start) : 10_000 + index,
  }));
  scored.sort((left, right) => left.score - right.score);
  const seen = new Set<string>();
  const nearby: Array<{ factId: string; key: string; witness: string }> = [];
  for (const { row } of scored) {
    if (seen.has(row.factId)) continue;
    seen.add(row.factId);
    nearby.push({ factId: row.factId, key: row.key, witness: row.witness });
    if (nearby.length === 3) break;
  }
  return nearby;
}

function pad(node: { chapter: number }): string {
  return `ch${String(node.chapter).padStart(2, '0')}`;
}

/** The sentinel of a `--apply` value that is neither `all` nor a list of chapters. */
const INVALID_APPLY = Symbol('invalid apply');

/**
 * `--apply <chapters|all>`: the chapters the plan executes. `null` is «the plan's own set» — the
 * origin for `local`, every priced chapter otherwise — which is what the engine does when the
 * author presses «apply all», and the default. A list narrows it.
 */
function appliedChapters(raw: string | null): number[] | null | typeof INVALID_APPLY {
  if (raw === null || raw.trim().toLowerCase() === 'all') return null;
  const parts = raw.split(/[\s,]+/u).filter((part) => part !== '');
  if (parts.length === 0) return INVALID_APPLY;
  const chapters = parts.map(Number);
  const valid = chapters.every(
    (chapter) => Number.isInteger(chapter) && chapter >= 1 && chapter <= 67,
  );
  return valid ? chapters : INVALID_APPLY;
}

function factLine(node: { chapter: number; factId: string; key: string; kind: string }): string {
  return `${pad(node)}  ${node.factId}  ${node.key || node.kind}  [${node.kind}]`;
}

function seedsLine(db: Db, seeds: readonly string[]): string {
  const facts = seeds.map((id) => {
    const row = db.prepare(`SELECT key, kind, chapter FROM facts WHERE id = ?`).get(id) as
      | { key: string; kind: string; chapter: number }
      | undefined;
    return row === undefined ? id : `${id} (${row.key || row.kind}, ${pad(row)})`;
  });
  return `${String(seeds.length)} ${pluralEn(seeds.length, 'seed', 'seeds')}: ${facts.join(', ')}`;
}

export function closureCommand(argv: readonly string[], io: GraphIo): number {
  const flags = parseFlags(argv);
  if (flags.unknown.length > 0) {
    io.error(`graph: unknown argument "${flags.unknown[0] ?? ''}"`);
    return 2;
  }
  if (flags.invalid.length > 0) {
    io.error(`graph: ${flags.invalid[0] ?? ''}`);
    return 2;
  }
  const dataDir = flags.dataDir;
  if (dataDir === null || dataDir === '') {
    io.error('graph: --data-dir is required');
    return 2;
  }
  const applied = appliedChapters(flags.apply);
  if (applied === INVALID_APPLY) {
    io.error(`graph: --apply "${flags.apply ?? ''}" is not "all" or a list of chapters`);
    return 2;
  }
  // Two selectors are two answers to «what changed»; picking one silently would price a change
  // the operator never described.
  if (flags.fact !== null && flags.fact !== '' && (flags.chapter !== null || flags.quote !== null)) {
    io.error('graph: --fact excludes --chapter/--quote — one selector per run');
    return 2;
  }
  const db = openGraphDb(dataDir);
  try {
    let seeds: string[] = [];
    let origin: number | null = null;
    if (flags.fact !== null && flags.fact !== '') {
      const chapter = chapterOfFact(db, flags.fact);
      if (chapter === null) {
        io.error(`graph: no fact ${flags.fact}`);
        return 1;
      }
      seeds = [flags.fact];
      origin = chapter;
    } else if (flags.chapter !== null && flags.quote !== null) {
      const chapter = Number(flags.chapter);
      if (!Number.isInteger(chapter) || chapter < 1 || chapter > 67) {
        io.error(`graph: --chapter "${flags.chapter}" is not a chapter number`);
        return 2;
      }
      const hits = factsMatchingQuote(db, chapter, flags.quote);
      if (hits.length === 0) {
        io.log('no fact in this sentence');
        for (const near of nearbyMentions(db, chapter, flags.quote)) {
          io.log(`  nearby: ch${String(chapter).padStart(2, '0')}  ${near.factId}  ${near.key}  «${near.witness}»`);
        }
        return 0;
      }
      seeds = hits.map((hit) => hit.factId);
      origin = chapter;
    } else {
      io.error('graph: closure needs --fact <fct_…> or --chapter <n> --quote "…"');
      return 2;
    }

    const measured = closure(db, seeds);
    const split = mandatoryOf(db, measured.nodes, { origin, touched: seeds });
    const mandatory = split.mandatory.map((entry) => entry.factId);
    const chaptersOfNode = new Map(measured.nodes.map((node) => [node.factId, node.chapter]));
    const touched = new Set(seeds);
    const input: ModeInput = {
      origin,
      nodes: measured.nodes,
      mandatory,
      // Every mandatory node lost its support; patching it is what the plan promises. Whether it
      // is actually executed is `--apply`'s answer, not this list's.
      orphaned: [...mandatory],
      touched: seeds,
      applied,
      crossingEdge: measured.edges.some(
        (edge) =>
          chaptersOfNode.get(edge.fromFact) !== chaptersOfNode.get(edge.toFact) &&
          (touched.has(edge.fromFact) || touched.has(edge.toFact)) &&
          (chaptersOfNode.get(edge.fromFact) === origin || chaptersOfNode.get(edge.toFact) === origin),
      ),
      changedChars: flags.changedChars ?? 0,
      outcomeReversed: false,
      laneLost: false,
      irreversibleLost: false,
      // Unit prices are known for the extraction's models; a plan that cannot be priced is wide.
      priced: true,
      unstable: null,
    };
    const decision = decide(input);

    if (flags.json) {
      // Flattened on purpose: `jq .nodes`, `jq .price`, `jq .decision.mode` all work without a
      // second hop through a wrapper, and the closure's own fields are unambiguous at the top.
      io.log(
        JSON.stringify(
          {
            ...measured,
            mandatory: split.mandatory,
            optional: split.optional,
            price: decision.price,
            decision: { mode: decision.mode, refused: decision.refused, reasons: decision.reasons },
          },
          null,
          2,
        ),
      );
      return 0;
    }

    io.log(seedsLine(db, measured.seeds));
    const chapterCount = measured.chapters.length;
    io.log(
      `closure: ${String(measured.nodes.length)} ${pluralEn(measured.nodes.length, 'node', 'nodes')} · ` +
        `${String(chapterCount)} ${pluralEn(chapterCount, 'chapter', 'chapters')} ` +
        `(${measured.chapters.join(',')}) · parts ${measured.parts.join(', ')} · ` +
        `back ${String(measured.back)} / forward ${String(measured.forward)} · ` +
        `cycles ${String(measured.cycles.length)}`,
    );
    for (const cycle of measured.cycles) io.log(`  cycle: ${cycle.nodes.join(' → ')} → ${cycle.nodes[0] ?? ''}`);
    io.log(`mandatory (${String(split.mandatory.length)}):`);
    for (const entry of split.mandatory) io.log(`  ${factLine(entry)}  ${entry.reason}`);
    io.log(`optional (${String(split.optional.length)}):`);
    for (const entry of split.optional) io.log(`  ${factLine(entry)}  ${entry.reason}`);
    io.log(`mode: ${decision.mode}`);
    const price = decision.price;
    io.log(
      `price: $${price.usd.toFixed(2)} · ${String(price.chapters)} ` +
        `${pluralEn(price.chapters, 'chapter', 'chapters')} · ${String(price.patches)} ` +
        `${pluralEn(price.patches, 'patch', 'patches')} · ${String(price.changedChars)} ` +
        `${pluralEn(price.changedChars, 'char', 'chars')}`,
    );
    if (decision.refused !== null) io.log(`refused: ${decision.refused.code} — «${decision.refused.sentence}»`);
    return 0;
  } catch (error) {
    io.error(`graph: closure failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

export function benchCommand(argv: readonly string[], io: GraphIo): number {
  const flags = parseFlags(argv);
  if (flags.unknown.length > 0) {
    io.error(`graph: unknown argument "${flags.unknown[0] ?? ''}"`);
    return 2;
  }
  const dataDir = flags.dataDir;
  if (dataDir === null || dataDir === '') {
    io.error('graph: --data-dir is required');
    return 2;
  }
  const db = openGraphDb(dataDir);
  try {
    const result = bench(db);
    if (flags.json) io.log(JSON.stringify(result, null, 2));
    else {
      io.log(
        `bench: ${String(result.runs)} ${pluralEn(result.runs, 'run', 'runs')} · ` +
          `p50 ${result.p50.toFixed(2)} ms · p95 ${result.p95.toFixed(2)} ms · max ${result.max.toFixed(2)} ms`,
      );
      io.log(
        `nodes avg ${String(result.nodesAvg)} max ${String(result.nodesMax)} · json ${String(result.jsonBytesMax)} bytes`,
      );
    }
    if (result.p95 > 25) {
      io.error(`graph: bench FAIL — p95 ${result.p95.toFixed(2)} ms > 25 ms (ADR-040 §3.4)`);
      return 1;
    }
    return 0;
  } catch (error) {
    io.error(`graph: bench failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}
