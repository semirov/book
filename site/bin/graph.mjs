#!/usr/bin/env node
/**
 * bin/graph.mjs — the extracted graph, built and read without the engine.
 *
 *   graph.mjs extract (--chapter <n> | --chapters 1-15,20 | --all | --pending)
 *                     [--force] [--dry-run] [--no-recall] [--json] [--data-dir <dir>]
 *                     [--max-output <n>]
 *   graph.mjs report  --data-dir <dir> [--json]
 *   graph.mjs samples --data-dir <dir> [--limit 10]
 *   graph.mjs audit   --data-dir <dir> [--chapter N] [--json]
 *   graph.mjs closure --data-dir <dir> (--fact fct_… | --chapter N --quote "…")
 *                     [--changed-chars N] [--json]
 *   graph.mjs bench   --data-dir <dir> [--json]
 *
 * `extract` reads the chapter with the model (the pipeline pin in `config/pipeline.json`) and asks
 * for the key in `DEEPSEEK_API_KEY_FILE` (owner-only mode) or `DEEPSEEK_API_KEY`; a missing key is
 * `KEY_MISSING` and nothing else. `--dry-run` asks the model and writes nothing. `--pending` takes
 * every written chapter whose current text has no completed pass. `--no-recall` skips the second,
 * adversarial pass; without it the recall runs and its additions are printed with the chapter.
 * `--max-output <n>` (1024–131072) is the request's own `max_tokens` for one run, both passes —
 * the diagnostic knob a truncation is read against.
 *
 * `--data-dir` is required by the CLI on purpose: a measurement run must not be able to land in
 * the live data directory by accident of an unset variable. The text is read from that database
 * (ADR-043, BOOK-DOC-76) — the tool never imports a manuscript: a chapter with no blocks is
 * `NO_CHAPTER_TEXT`, and the one-shot import is the operator's own door.
 *
 * `audit` re-asks the support question of every live fact's own witness and writes nothing: it
 * exits 1 when a witness does not prove its value, so it can be a gate.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE_ROOT, 'server', 'dist');

async function main() {
  const entry = join(DIST, 'graph', 'cli.js');
  if (!existsSync(entry)) {
    console.error('graph: the server is not built — run `npm run build -w @book/server` first');
    return 1;
  }
  const { runGraph } = await import(pathToFileURL(entry).href);
  // `extract` is async (it waits on the model); every other command returns its number at once.
  return await runGraph(
    process.argv.slice(2),
    { log: (line) => console.log(line), error: (line) => console.error(line) },
    {},
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`graph: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
