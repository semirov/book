#!/usr/bin/env node
/**
 * `npm run test:model` — the pinned corpus, run against the real model (ADR-038 §4, §6).
 *
 * This is **not** a gate on a commit and never enters `verify`, `test`, `test:coverage`,
 * `build` or CI: it is a release check and an on-demand check after any change to a prompt, an
 * envelope or a gate. It calls the provider; the deterministic suite calls nothing.
 *
 *   node model-lane/run.mjs --dry-run   # resolve prompts, validate the corpus, print coverage, no call
 *   node model-lane/run.mjs             # the live run, with the key in the environment
 *
 * Exit: 0 every runnable row matched · 1 a mismatch or a malformed answer · 2 the lane could not
 * run (key, provider, corpus, prompt file). Blocked rows never change the code — they are
 * counted and named, because gate A and gate B are BOOK-61's prompts, not a defect here.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS, GATE_VERDICTS, validateCorpus } from './corpus.mjs';
import { costUsd, newRunId, provenanceLine, readProvenance, writeEvidence } from './evidence.mjs';
import { FILING_VERSION, batchId, buildEnvelope, envelopeSha256, fenced, jsonLine } from './envelope.mjs';
import { readPipeline, LaneError } from './pipeline.mjs';
import { PROMPTS_PATH, SECTION_OF_GATE, resolvePrompts } from './prompts.mjs';
import { complete, readKey } from './provider.mjs';
import { VERDICT_VERSION, parseGateAnswer } from './verdict.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

const line = (...parts) => console.log(parts.join(' '));

/**
 * Every row, with the gate's prompt resolved or the exact blocked reason (§5). The envelope is
 * minted per **call**, not per run: BOOK-DOC-42 §2 mints the fence for one batch, and a corpus row
 * is a one-item batch, so two answers can never share a token (review, nit 14).
 */
function planRows(prompts) {
  return CORPUS.map((row) => {
    const section = prompts[SECTION_OF_GATE[row.gate]];
    return { row, section, blocked: section.ok ? null : section.reason };
  });
}

function printCoverage(plan) {
  const auditRows = plan.filter((entry) => !entry.row.id.startsWith('fp-'));
  const fpRows = plan.filter((entry) => entry.row.id.startsWith('fp-'));
  const blocked = plan.filter((entry) => entry.blocked !== null);
  for (const gate of ['A', 'B', 'C']) {
    const ofGate = plan.filter((entry) => entry.row.gate === gate);
    const reasons = [...new Set(ofGate.filter((entry) => entry.blocked !== null).map((entry) => entry.blocked))];
    const runnable = ofGate.length - ofGate.filter((entry) => entry.blocked !== null).length;
    line(
      `gate ${gate}: ${String(ofGate.length).padStart(2)} rows · runnable ${String(runnable)}` +
        (reasons.length === 0 ? '' : ` · blocked ${reasons.join('; ')}`),
    );
  }
  const run = (entries) => entries.filter((entry) => entry.blocked === null).length;
  const stop = (entries) => entries.filter((entry) => entry.blocked !== null).length;
  line(
    `corpus: ${String(auditRows.length)} audit + ${String(fpRows.length)} false-positive rows · ` +
      `fp runnable ${String(run(fpRows))} · blocked ${String(stop(fpRows))}`,
  );
  line(`run ${String(run(auditRows))}/42 audit rows · blocked ${String(blocked.length)}`);
}

/**
 * The parser's own unit row, exercised without a call: a `book.verdict/v1` answer bound to the
 * envelope's `itemId` with a real quote from its `text`, a foreign item (malformed), and a plain
 * answer. This is plumbing — it proves the answer path is wired today, so the day BOOK-61 lands
 * §0a/§0b the only new thing is a live answer.
 */
function plumbing() {
  const batch = batchId('model-lane-dry-run');
  const row = { id: 'plumbing', gate: 'C', input: 'Акт: смотритель уходит в ночную смену и оставляет ключ.' };
  const envelope = buildEnvelope(row, { batch, kind: 'document' });
  const verdict = (itemId) =>
    JSON.stringify({
      envelope: VERDICT_VERSION,
      itemId,
      gate: 'C',
      verdict: 'FITS',
      evidence: [{ field: 'text', quote: 'смотритель уходит в ночную смену' }],
    });
  const versioned = parseGateAnswer(verdict(envelope.itemId), row, envelope);
  const foreign = parseGateAnswer(verdict('cmt_01JB7SOMEONEELSE000000000'), row, envelope);
  const plain = parseGateAnswer('OFF — это просьба переписать сцену, а не мировой факт.', row, envelope);
  const broken = parseGateAnswer('мне кажется, это неплохо', row, envelope);
  if (!versioned.ok || versioned.verdict !== 'FITS') throw new LaneError('PARSER_SELFTEST', 'book.verdict/v1 did not parse');
  if (foreign.ok) throw new LaneError('PARSER_SELFTEST', 'a verdict for another item parsed');
  if (!plain.ok || plain.verdict !== 'OFF') throw new LaneError('PARSER_SELFTEST', 'the plain form did not parse');
  if (broken.ok) throw new LaneError('PARSER_SELFTEST', 'an unparseable answer produced a verdict');
  line(
    `parser: book.verdict/v1 (itemId bound) · plain ${GATE_VERDICTS.C.join('|')} · ` +
      `foreign item → ${foreign.error} · garbage → ${broken.error}`,
  );
  line(`filing: ${FILING_VERSION} · batch ${batch} · ${envelopeSha256(jsonLine(envelope)).slice(0, 12)}`);
}

/** The first 280 characters of an answer, trimmed — enough for an issue to quote it, never prose. */
const headOf = (text) => String(text ?? '').trim().slice(0, 280);

/** One row, one call: the gate's prompt is the system turn, the fenced envelope the user turn. */
async function runRow(pipeline, entry, facts = {}) {
  const { row, section } = entry;
  const at = new Date().toISOString();
  // One row is one batch: its own fence token, its own item (BOOK-DOC-42 §2).
  const batch = batchId();
  const envelope = buildEnvelope(row, { batch, kind: row.kind });
  const envelopeLine = jsonLine(envelope);
  facts.batch = batch;
  facts.itemId = envelope.itemId;
  facts.envelopeSha256 = envelopeSha256(envelopeLine);
  const answer = await complete(pipeline, [
    { role: 'system', content: section.prompt },
    { role: 'user', content: fenced(envelopeLine, batch) },
  ]);
  const cost = costUsd(answer.usage, pipeline.pricing);
  const base = {
    row: row.id,
    gate: row.gate,
    surface: row.surface,
    kind: envelope.kind,
    batch,
    itemId: envelope.itemId,
    envelopeSha256: facts.envelopeSha256,
    declaredModel: pipeline.model,
    responseModel: answer.responseModel,
    sectionSha256: section.sectionSha256,
    promptSha256: section.promptSha256,
    finishReason: answer.finishReason,
    reasoningTokens: answer.reasoningTokens,
    streamComplete: answer.streamComplete,
    latencyMs: answer.latencyMs,
    usage: answer.usage,
    costUsd: cost,
    at,
  };
  // A 200 with empty content is a billed call that answered nothing (a reasoning model that
  // spent the cap). It is not a transport error and not a verdict: record it and move on.
  if (answer.empty) {
    return {
      ...base,
      status: 'error',
      error: 'ANSWER_EMPTY',
      reason: `the answer was empty (finish_reason ${answer.finishReason ?? 'absent'})`,
      answerHead: headOf(answer.text),
      answerFormat: null,
      expected: row.expect.verdict,
      verdict: null,
      rule: null,
    };
  }
  const parsed = parseGateAnswer(answer.text, row, envelope);
  if (!parsed.ok) {
    return {
      ...base,
      status: 'error',
      error: parsed.error,
      reason: parsed.reason,
      answerHead: headOf(answer.text),
      answerFormat: null,
      expected: row.expect.verdict,
      verdict: null,
      rule: null,
    };
  }
  const verdict = parsed.verdict;
  const expectedRule = row.expect.rule ?? null;
  const ruleOk = expectedRule === null || parsed.rule === expectedRule;
  const status = verdict === row.expect.verdict && ruleOk ? 'ok' : 'mismatch';
  return {
    ...base,
    status,
    answerFormat: parsed.format,
    verdict,
    rule: parsed.rule,
    expected: row.expect.verdict,
    expectedRule,
    expectedSource: row.expect.source,
    ...(row.expect.why === undefined ? {} : { why: row.expect.why }),
    ...(row.expect.corrected === undefined ? {} : { corrected: row.expect.corrected }),
    // Only a disagreement carries the model's words: an `ok` row keeps none (no prose in evidence).
    ...(status === 'mismatch' ? { answerHead: headOf(answer.text) } : {}),
    audit: row.audit,
  };
}

function blockedCall(entry) {
  return {
    row: entry.row.id,
    gate: entry.row.gate,
    surface: entry.row.surface,
    kind: entry.row.kind,
    status: 'blocked',
    blocked: entry.blocked,
    expected: entry.row.expect.verdict,
    expectedSource: entry.row.expect.source,
    audit: entry.row.audit,
    at: new Date().toISOString(),
  };
}

async function main() {
  if (HELP) {
    line('usage: node model-lane/run.mjs [--dry-run]');
    return 0;
  }
  const pipeline = readPipeline();
  const prompts = resolvePrompts();
  const problems = validateCorpus();
  if (problems.length > 0) throw new LaneError('CORPUS_INVALID', problems.join('; '));
  // Read once, at the start: the evidence's `commit`/`dirty` describe the tree the run started
  // on, not the one the run's own evidence directory has since made dirty.
  const origin = readProvenance();
  const plan = planRows(prompts);

  line(`pipeline: ${pipeline.model} → ${pipeline.apiModel} · prompts process/ROLE_PROMPTS.md`);
  line(`envelope: ${FILING_VERSION} · one fence per call (one row = one batch)`);
  printCoverage(plan);

  if (DRY_RUN) {
    plumbing();
    line(provenanceLine(origin));
    line('dry run: no call, no transcript');
    return 0;
  }

  // The key is read before anything else can spend money: missing means zero calls, exit 2.
  const key = readKey();
  line(`key: ${key.source} (value never printed)`);

  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const calls = [];
  for (const entry of plan) {
    if (entry.blocked !== null) {
      calls.push(blockedCall(entry));
      continue;
    }
    // `facts` is filled by `runRow` as soon as the envelope exists, so a failed call still names
    // the batch and the item it was sent under.
    const facts = { batch: null, itemId: null, envelopeSha256: null };
    try {
      calls.push(await runRow(pipeline, entry, facts));
    } catch (error) {
      // One row's failure is one row's fact: a lane refusal keeps its code, and an unexpected
      // error is recorded **as a bug** (`LANE_INTERNAL`, with the error's own name) — never
      // swallowed, never a reason to abandon the rows that already cost money.
      const lane = error instanceof LaneError;
      calls.push({
        row: entry.row.id,
        gate: entry.row.gate,
        kind: entry.row.kind,
        batch: facts.batch,
        itemId: facts.itemId,
        envelopeSha256: facts.envelopeSha256,
        status: 'error',
        error: lane ? error.code : 'LANE_INTERNAL',
        reason: lane ? error.message : `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        expected: entry.row.expect.verdict,
        at: new Date().toISOString(),
      });
    }
  }
  const finishedAt = new Date().toISOString();
  // Evidence before any print: the run is paid for, so the file lands even if a summary line
  // throws (this is exactly the call that a missing import once turned into a lost run).
  const written = writeEvidence({
    mode: 'corpus',
    runId,
    run: 'corpus',
    startedAt,
    finishedAt,
    pipeline,
    calls,
    origin,
    extra: { promptsPath: PROMPTS_PATH },
  });

  const mismatches = calls.filter((call) => call.status === 'mismatch');
  const errors = calls.filter((call) => call.status === 'error');
  const exitCode = mismatches.length === 0 && errors.length === 0 ? 0 : 1;
  // The evidence is on disk by now: a bug in a report line must not change the exit code, only
  // say so — the file the owner reads is already written.
  try {
    for (const call of [...mismatches, ...errors]) {
      line(
        `${call.status.toUpperCase()} ${call.row} (${call.gate}): got ${call.verdict ?? call.error}, expected ${call.expected} — ${call.audit ?? ''}`,
      );
    }
    const ranAudit = calls.filter((call) => !call.row.startsWith('fp-') && call.status !== 'blocked').length;
    line(
      `run ${String(ranAudit)}/42 audit rows answered · ${String(mismatches.length)} mismatch · ` +
        `${String(errors.length)} error · blocked ${String(calls.filter((call) => call.status === 'blocked').length)}`,
    );
    // The provider's own bookkeeping, per run: a `length` count or a large reasoning count is
    // what explains an empty answer, so both are printed, not buried in the file.
    const reasons = {};
    let reasoning = 0;
    let incomplete = 0;
    for (const call of calls) {
      if (call.finishReason) reasons[call.finishReason] = (reasons[call.finishReason] ?? 0) + 1;
      reasoning += call.reasoningTokens ?? 0;
      if (call.streamComplete === false) incomplete += 1;
    }
    line(
      `answers: ${Object.entries(reasons).map(([key, value]) => `${key} ${String(value)}`).join(' · ') || 'none'} · ` +
        `reasoning ${String(reasoning)} tokens · incomplete streams ${String(incomplete)} · ` +
        `max_tokens ${String(pipeline.maxOutputTokens)}`,
    );
    line(
      `cost: $${written.totals.costUsd.toFixed(6)} · tokens ${String(written.totals.tokensIn)}/${String(written.totals.tokensOut)} · ${written.path}`,
    );
    line(provenanceLine(origin));
  } catch (error) {
    console.error(`model-lane: REPORT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`model-lane: evidence is written at ${written.path}`);
  }
  return exitCode;
}

/**
 * Only the entrypoint runs the corpus: a check may import `runRow` (and drive it against a
 * local stand-in server) without starting a paid run.
 */
const entrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (entrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof LaneError) {
        console.error(`model-lane: ${error.code}: ${error.message}`);
        process.exitCode = 2;
        return;
      }
      console.error(`model-lane: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
}

export { planRows, runRow };
