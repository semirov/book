/**
 * `bin/graph.mjs`'s implementation (BOOK-185): extraction over the manuscript, and the two views
 * that make it checkable — a per-chapter report and a quoted sample. The closure and the benchmark
 * live in `closureCli.ts`; the flag parser and the connection live in `cliArgs.ts`.
 *
 * Exit codes are the index CLI's, because two tools that disagree about what a failed run looks
 * like are two tools an operator has to remember separately: 0 done, 1 missing or unbuildable
 * (no database, no chapters, an extraction that refuses, no model key), 2 bad usage or an unknown
 * command.
 *
 * `extract` drives the model pass (BOOK-DOC-77): the provider is the pipeline's pin and the key,
 * and every chapter prints what it produced and what it cost. `--dry-run` asks the model and
 * writes nothing; `--pending` is «every chapter whose current text has no completed run»; a
 * missing key is `KEY_MISSING` and nothing else — never its path, never its value.
 *
 * `extract` imports the manuscript first when the requested chapters are not in the projection:
 * the database is a projection of the files (ADR-002), and extracting a projection nobody
 * refreshed would measure last week's text. `--no-reconcile` exists for a caller that has just
 * imported and does not want a second scan.
 */

import type { Db } from '../db/db.ts';
import { listChapterRows } from '../db/repo/chapters.ts';
import { reconcile } from '../ingest/reconcile.ts';
import { apiModelOf, loadPipeline, type Pipeline } from '../pipeline.ts';
import { toIso } from '../util/time.ts';
import { auditFacts, renderAudit } from './audit.ts';
import { maxOutputProblem, openGraphDb, parseFlags, type GraphFlags } from './cliArgs.ts';
import { chapterLine, countsOf, modeOf, rejectCounts, rejectLine, usd, type RunJson } from './cliFormat.ts';
import { benchCommand, closureCommand } from './closureCli.ts';
import { extractChapter, isAnswered, prepareChapter, type Provider } from './extract.ts';
import { complete, DEFAULT_PIPELINE_PATH, loadModelConfig, ModelConfigError, timeoutFromEnv } from './model.ts';
import { buildReport, renderReport } from './report.ts';
import { buildSamples } from './samples.ts';

export type GraphIo = { log: (line: string) => void; error: (line: string) => void };

/** The model seam: the pin the run is charged at, and the transport it asks. Injected by tests. */
export type ModelSeam = { pipeline: Pipeline; provider: Provider };

export type GraphDefaults = { bookRoot: string; model?: ModelSeam };

/** `1-15,20` → [1..15, 20]; anything that is not a chapter number is a usage error. */
export function parseChapters(spec: string): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const range = /^(\d{1,2})-(\d{1,2})$/u.exec(piece);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > 67 || from > to) return null;
      for (let n = from; n <= to; n += 1) out.add(n);
      continue;
    }
    if (!/^\d{1,2}$/u.test(piece)) return null;
    const n = Number(piece);
    if (n < 1 || n > 67) return null;
    out.add(n);
  }
  return out.size === 0 ? null : [...out].sort((left, right) => left - right);
}

// ---------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------

/**
 * The real seam: the pin from `config/pipeline.json` (or `PIPELINE_PATH`) and the key from
 * `DEEPSEEK_API_KEY_FILE` / `DEEPSEEK_API_KEY` with the mode check `model.ts` enforces. A bad key
 * throws `ModelConfigError`, whose message names a variable and a rule and never a path or a value.
 */
function realSeam(): ModelSeam {
  const config = loadModelConfig();
  const pipeline = loadPipeline((process.env.PIPELINE_PATH ?? '').trim() || DEFAULT_PIPELINE_PATH);
  const timeoutMs = timeoutFromEnv();
  const provider: Provider = async (request) => {
    const result = await complete(config, {
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      timeoutMs,
    });
    return {
      text: result.text,
      model: result.model,
      usage: result.usage,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason,
    };
  };
  return { pipeline, provider };
}

// ---------------------------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------------------------

const SELECTORS = ['--chapter', '--chapters', '--all', '--pending'] as const;

function chapterSelector(flags: GraphFlags): { explicit: number[] | null; all: boolean; pending: boolean } | null {
  const chosen = SELECTORS.filter((name) => {
    if (name === '--chapter') return flags.chapter !== null;
    if (name === '--chapters') return flags.chapters !== null;
    if (name === '--all') return flags.all;
    return flags.pending;
  });
  if (chosen.length !== 1) return null;
  if (flags.chapter !== null) {
    if (!/^\d{1,2}$/u.test(flags.chapter.trim())) return null;
    const n = Number(flags.chapter);
    if (n < 1 || n > 67) return null;
    return { explicit: [n], all: false, pending: false };
  }
  if (flags.chapters !== null) {
    const list = parseChapters(flags.chapters);
    return list === null ? null : { explicit: list, all: false, pending: false };
  }
  return { explicit: null, all: flags.all, pending: flags.pending };
}

function hasBlocks(db: Db, chapter: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE chapter = ?').get(chapter) as { n: number };
  return row.n > 0;
}

async function extractCommand(argv: readonly string[], io: GraphIo, defaults: GraphDefaults): Promise<number> {
  const flags = parseFlags(argv);
  if (flags.unknown.length > 0) {
    io.error(`graph: unknown argument "${flags.unknown[0] ?? ''}"`);
    return 2;
  }
  // A malformed counted flag is a usage error here too: extract is the command the operator runs
  // with a number in hand, and a value that never became one must not reach the request.
  if (flags.invalid.length > 0) {
    io.error(`graph: ${flags.invalid[0] ?? ''}`);
    return 2;
  }
  const maxProblem = maxOutputProblem(flags.maxOutput);
  if (maxProblem !== null) {
    io.error(maxProblem);
    return 2;
  }
  const dataDir = flags.dataDir;
  if (dataDir === null || dataDir === '') {
    io.error('graph: --data-dir is required');
    return 2;
  }
  const selector = chapterSelector(flags);
  if (selector === null) {
    io.error('graph: extract takes one of --chapter <n>, --chapters <list>, --all, --pending');
    return 2;
  }

  let seam: ModelSeam;
  try {
    seam = defaults.model ?? realSeam();
  } catch (error) {
    // A key failure names a variable and a rule; the path and the value never reach the console.
    if (error instanceof ModelConfigError) {
      io.error(`graph: ${error.message}`);
      return 1;
    }
    io.error(`graph: the model is unusable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const model = apiModelOf(seam.pipeline);
  /**
   * What both calls ask with: the run's own `--max-output`, or the pin. The recall gets the same
   * cap — it is the longer answer of the two, and one truncated pass loses the chapter.
   */
  const maxOutput = flags.maxOutput ?? seam.pipeline.maxOutputTokens;

  const db = openGraphDb(dataDir);
  try {
    const at = toIso(Date.now());
    let present = listChapterRows(db).map((row) => row.n);
    const requested = selector.explicit;
    // The database is a projection of the files, so the import runs when the question is about
    // text this projection may not hold: the whole book (`--all`/`--pending`), a chapter with no
    // row or no blocks, or an empty data directory. `--no-reconcile` is the caller's override.
    const needsImport =
      !flags.noReconcile &&
      (selector.all ||
        selector.pending ||
        present.length === 0 ||
        (requested ?? []).some((n) => !present.includes(n) || !hasBlocks(db, n)));
    if (needsImport) {
      const report = reconcile(db, { bookRoot: flags.bookRoot ?? defaults.bookRoot, dataDir, now: new Date(at) });
      io.log(
        `reconcile: scanned ${String(report.scanned)} — created ${report.created.length}, revised ${report.revised.length}, ` +
          `unchanged ${report.unchanged.length}, removed ${report.removed.length}`,
      );
      present = listChapterRows(db).map((row) => row.n);
    }
    // The recall is on by default (BOOK-DOC-77 §4); the operator's `--no-recall` is the cheap path.
    (flags.json ? io.error : io.log)(flags.noRecall ? 'recall: off' : 'recall: on');

    let chapters: number[];
    if (requested !== null) {
      const missing = requested.filter((n) => !present.includes(n));
      if (missing.length > 0) {
        io.error(`graph: no chapter row for ${missing.join(', ')}`);
        return 1;
      }
      chapters = requested;
    } else if (selector.all) {
      chapters = present.filter((n) => hasBlocks(db, n));
    } else {
      chapters = present.filter(
        (n) => hasBlocks(db, n) && !isAnswered(db, prepareChapter(db, n, model), model, flags.noRecall),
      );
    }

    if (chapters.length === 0) {
      if (selector.pending) {
        io.log('pending: nothing to extract — every written chapter has a completed run');
        return 0;
      }
      io.error(`graph: nothing to extract in ${dataDir}`);
      return 1;
    }

    const total = {
      facts: 0,
      uses: 0,
      edges: 0,
      threads: 0,
      rejects: 0,
      usd: 0,
      tokens: { in: 0, out: 0, cached: 0 },
      extract: { in: 0, out: 0, cached: 0 },
      recall: { in: 0, out: 0, cached: 0 },
      added: { facts: 0, edges: 0, threads: 0 },
    };
    let failures = 0;

    for (const chapter of chapters) {
      const outcome = await extractChapter({
        db,
        chapter,
        provider: seam.provider,
        pipeline: seam.pipeline,
        at,
        ...(flags.force ? { force: true } : {}),
        ...(flags.dryRun ? { dryRun: true } : {}),
        ...(flags.noRecall ? { noRecall: true } : {}),
        ...(flags.maxOutput === null ? {} : { maxOutputTokens: flags.maxOutput }),
      });
      const codes = rejectCounts(outcome.rejects);
      const counts = countsOf(outcome);
      const mode = modeOf(outcome);
      const error = outcome.ok ? null : outcome.code;
      const recall = outcome.passes.recall;
      const recallAdded = recall.skipped ? { facts: 0, edges: 0, threads: 0 } : recall.added;

      total.facts += counts.facts;
      total.uses += counts.uses;
      total.edges += counts.edges;
      total.threads += counts.threads;
      total.rejects += outcome.rejects.length;
      total.usd += outcome.usd;
      total.tokens.in += outcome.usage.in;
      total.tokens.out += outcome.usage.out;
      total.tokens.cached += outcome.usage.cached;
      total.extract.in += outcome.passes.extract.usage.in;
      total.extract.out += outcome.passes.extract.usage.out;
      total.extract.cached += outcome.passes.extract.usage.cached;
      if (!recall.skipped) {
        total.recall.in += recall.usage.in;
        total.recall.out += recall.usage.out;
        total.recall.cached += recall.usage.cached;
      }
      total.added.facts += recallAdded.facts;
      total.added.edges += recallAdded.edges;
      total.added.threads += recallAdded.threads;
      if (!outcome.ok) failures += 1;

      if (flags.json) {
        const recallCodes = recall.skipped ? {} : rejectCounts(recall.rejects);
        const row: RunJson = {
          chapter,
          rev: outcome.rev,
          run: outcome.run,
          mode,
          ok: outcome.ok,
          error,
          facts: counts.facts,
          uses: counts.uses,
          edges: counts.edges,
          threads: counts.threads,
          rejects: outcome.rejects.length,
          rejectCodes: codes,
          usd: outcome.usd,
          tokens: outcome.usage,
          model: outcome.model,
          promptSha: outcome.promptSha,
          runs: {
            extract: outcome.run,
            recall: recall.skipped ? null : recall.run,
          },
          tokensByPass: {
            extract: outcome.passes.extract.usage,
            recall: recall.skipped ? null : recall.usage,
          },
          // The cap the extract request asked with — the one number a truncation is read against.
          maxOutput,
          recallAdded,
          recall: recall.skipped
            ? null
            : {
                ok: recall.ok,
                error: recall.code,
                rejects: recall.rejects.length,
                rejectCodes: recallCodes,
                usd: recall.usd,
              },
        };
        io.log(JSON.stringify(row));
        continue;
      }
      io.log(
        chapterLine({
          chapter,
          rev: outcome.rev,
          counts,
          rejects: outcome.rejects.length,
          usd: outcome.usd,
          tokens: outcome.usage,
          passes: outcome.passes,
          mode,
          ...(error === null ? {} : { error }),
        }),
      );
      if (outcome.rejects.length > 0) io.log(`   rejects: ${rejectLine(codes)}`);
      if (!recall.skipped && !recall.ok) {
        io.log(`   recall: failed ${recall.code ?? 'ERROR'} — the first pass stands`);
      }
    }

    if (!flags.json) {
      io.log(
        `total: ${String(chapters.length)} chapters · facts ${String(total.facts)} · uses ${String(total.uses)} · ` +
          `edges ${String(total.edges)} · threads ${String(total.threads)} · rejects ${String(total.rejects)} · ` +
          `${usd(total.usd)}`,
      );
      io.log(
        `tokens: extract ${String(total.extract.in)}/${String(total.extract.out)}, recall ` +
          `${String(total.recall.in)}/${String(total.recall.out)} (in/out) · recall added ` +
          `+${String(total.added.facts)} facts, +${String(total.added.edges)} edges, ` +
          `+${String(total.added.threads)} threads`,
      );
      if (failures > 0) io.error(`graph: ${String(failures)} of ${String(chapters.length)} chapters refused`);
    }
    return failures > 0 ? 1 : 0;
  } catch (error) {
    io.error(`graph: extract failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// report, samples
// ---------------------------------------------------------------------------------------------

function reportCommand(argv: readonly string[], io: GraphIo): number {
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
    const report = buildReport(db);
    if (flags.json) io.log(JSON.stringify(report, null, 2));
    else for (const line of renderReport(report)) io.log(line);
    return 0;
  } catch (error) {
    io.error(`graph: report failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

function samplesCommand(argv: readonly string[], io: GraphIo): number {
  const flags = parseFlags(argv);
  if (flags.unknown.length > 0) {
    io.error(`graph: unknown argument "${flags.unknown[0] ?? ''}"`);
    return 2;
  }
  const limit = flags.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) {
    io.error(`graph: --limit must be a positive integer`);
    return 2;
  }
  const dataDir = flags.dataDir;
  if (dataDir === null || dataDir === '') {
    io.error('graph: --data-dir is required');
    return 2;
  }
  const db = openGraphDb(dataDir);
  try {
    io.log(JSON.stringify(buildSamples(db, limit), null, 2));
    return 0;
  } catch (error) {
    io.error(`graph: samples failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

/**
 * `graph audit [--chapter N]`: the support problem of every live fact's own witness. Read-only —
 * it opens the projection, asks `supportProblem` and prints; it writes no row and calls no model.
 * Exit 1 means a witness does not prove its value, so the command can be a gate.
 */
function auditCommand(argv: readonly string[], io: GraphIo): number {
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
  let chapter: number | undefined;
  if (flags.chapter !== null) {
    const raw = flags.chapter.trim();
    if (!/^\d{1,2}$/u.test(raw)) {
      io.error('graph: --chapter must be a chapter number');
      return 2;
    }
    chapter = Number(raw);
    if (chapter < 1 || chapter > 67) {
      io.error('graph: --chapter must be between 1 and 67');
      return 2;
    }
  }
  const db = openGraphDb(dataDir);
  try {
    const report = auditFacts(db, chapter === undefined ? {} : { chapter });
    if (flags.json) io.log(JSON.stringify(report, null, 2));
    else for (const line of renderAudit(report)) io.log(line);
    return report.failed === 0 ? 0 : 1;
  } catch (error) {
    io.error(`graph: audit failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

/**
 * The entry `bin/graph.mjs` calls. `extract` is the one async command — it waits on the model —
 * so the runner is `number | Promise<number>`; `bin/graph.mjs` awaits both, and a test of a sync
 * command reads the number it always did.
 */
export function runGraph(argv: readonly string[], io: GraphIo, defaults: GraphDefaults): number | Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'extract') return extractCommand(rest, io, defaults);
  if (command === 'report') return reportCommand(rest, io);
  if (command === 'samples') return samplesCommand(rest, io);
  if (command === 'audit') return auditCommand(rest, io);
  if (command === 'closure') return closureCommand(rest, io);
  if (command === 'bench') return benchCommand(rest, io);
  io.error(
    'usage: graph.mjs extract (--chapter <n> | --chapters <list> | --all | --pending)' +
      ' [--force] [--dry-run] [--no-recall] [--json] [--data-dir <dir>] [--max-output <n>]' +
      ' · report|samples|bench --data-dir <dir> [--json] [--limit <n>]' +
      ' · audit --data-dir <dir> [--chapter <n>] [--json]' +
      ' · closure --data-dir <dir> (--fact <fct_…> | --chapter <n> --quote "…")',
  );
  return 2;
}
