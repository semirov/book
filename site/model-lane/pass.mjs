#!/usr/bin/env node
/**
 * `npm run test:model:pass` — one real writing pass, on a scratch book (ADR-038 §7).
 *
 * The sequence `.opencode/skills/writing-pass/SKILL.md` gives, driven through `bin/engine.mjs`:
 * claim → start → write → land → both gates → close → trace. The point is volume and latency:
 * BOOK-34 found a lease dying under a real pass, and only a real pass finds that again.
 *
 * Nothing is mocked and no prompt is paraphrased: the briefs come from `process/ROLE_PROMPTS.md`
 * byte-for-byte, the model is `pipeline.json`'s, the answer is parsed by the corpus's rules, and
 * the transcript holds verdicts, hashes, usage and cost — never prose, never a finding's text.
 *
 *   node model-lane/pass.mjs --dry-run   # boots the engine, claims, starts, escalates — no call
 *   node model-lane/pass.mjs [--keep]    # the live pass; `--keep` keeps the scratch dirs
 *
 * Exit: 0 the step closed · 1 a mismatch or a pass that did not close · 2 the lane could not run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  costUsd,
  newRunId,
  provenanceLine,
  readProvenance,
  sha256,
  utcStamp,
  writeEvidence,
  writeFailureTranscript,
} from './evidence.mjs';
import { BOOK_ROOT, LaneError, readPipeline } from './pipeline.mjs';
import { SECTION_OF_ROLE, gateMessages, resolveInvariants, resolvePrompts, writerMessages } from './prompts.mjs';
import { complete, readKey } from './provider.mjs';
import { assertClosedTrace, frameCheck, openScratch } from './scratch.mjs';
import { parseRoleAnswer, unfence } from './verdict.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP = process.argv.includes('--keep');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

const CHAPTER_FLOOR = 1_600;
const REPORT_LINE = /^(REPORT|Report|ОТЧЁТ|Отчёт)\b/u;

const line = (...parts) => console.log(parts.join(' '));

/**
 * The answer, made into a chapter file (ADR-038 §7): one wrapping fence is removed and
 * recorded; a trailing report section is cut and recorded; nothing else is sanitised.
 */
function toProse(answer) {
  const { text, unfenced } = unfence(answer);
  const lines = text.split('\n');
  let cut = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (REPORT_LINE.test(lines[index].trim())) {
      cut = index;
      break;
    }
    if (lines[index].trim() === '---') {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0);
      if (next !== undefined && REPORT_LINE.test(next.trim())) {
        cut = index;
        break;
      }
    }
  }
  const prose = lines.slice(0, cut).join('\n').trim();
  return { prose, answerUnwrapped: unfenced, answerTrimmed: cut < lines.length };
}

const chapterName = (n) => `ch${String(n).padStart(2, '0')}.md`;

/** The provider facts every call records: model, hashes, finish state, usage, cost. */
function callFacts(answer, pipeline, section, invariants) {
  return {
    declaredModel: pipeline.model,
    responseModel: answer.responseModel,
    sectionSha256: section.sectionSha256,
    promptSha256: section.promptSha256,
    invariantsSha256: invariants.sha256,
    answerSha256: sha256(answer.text),
    finishReason: answer.finishReason,
    reasoningTokens: answer.reasoningTokens,
    streamComplete: answer.streamComplete,
    latencyMs: answer.latencyMs,
    usage: answer.usage,
    costUsd: costUsd(answer.usage, pipeline.pricing),
    at: new Date().toISOString(),
  };
}

/** One gate: dispatch, call, parse, record. Returns the facts the transcript keeps. */
async function answerGate(context, role) {
  const { scratch, prompts, pipeline, invariants, calls } = context;
  const gate = scratch.call(['next', '--role', role, '--session', `lane-${role}`]);
  if (gate === null) throw new LaneError('GATE_NOT_DISPATCHED', `the engine offered no ${role} assignment`);
  const text = readFileSync(join(scratch.bookRoot, 'manuscript', chapterName(gate.chapter ?? 1)), 'utf8');
  const messages = gateMessages(invariants, prompts, role, gate, text);
  const answer = await complete(pipeline, messages);
  const fact = { role, ...callFacts(answer, pipeline, prompts[SECTION_OF_ROLE[role]], invariants) };
  // A 200 with empty content is a billed call that answered nothing: recorded, then refused
  // under its own code — the lane cannot run without a graded pass, so exit 2.
  if (answer.empty) {
    calls.push({
      ...fact,
      status: 'error',
      error: 'ANSWER_EMPTY',
      reason: `the ${role} answer was empty (finish_reason ${answer.finishReason ?? 'absent'})`,
      answerHead: String(answer.text).trim().slice(0, 280),
    });
    throw new LaneError(
      'ANSWER_EMPTY',
      `the ${role} answered nothing (finish_reason ${answer.finishReason ?? 'absent'}, reasoning ${String(answer.reasoningTokens)} tokens)`,
    );
  }
  const parsed = parseRoleAnswer(answer.text, role);
  if (!parsed.ok) {
    calls.push({
      ...fact,
      status: 'error',
      error: 'VERDICT_MALFORMED',
      reason: parsed.reason,
      answerHead: String(answer.text).trim().slice(0, 280),
    });
    throw new LaneError('VERDICT_MALFORMED', `the ${role} answer has no HOLDS|GAP token (${parsed.reason})`);
  }
  const findingsPath = join(scratch.dataDir, `findings-${role}.json`);
  writeFileSync(findingsPath, JSON.stringify(parsed.findings), 'utf8');
  const result = scratch.call([
    'verdict',
    gate.stepId,
    '--role',
    role,
    '--session',
    `lane-${role}`,
    '--verdict',
    parsed.verdict,
    '--findings',
    findingsPath,
    '--model',
    pipeline.model,
    '--tokens-in',
    String(answer.usage.in),
    '--tokens-out',
    String(answer.usage.out),
  ]);
    calls.push({
      ...fact,
      status: 'ok',
      verdict: parsed.verdict,
      findings: parsed.findings.length,
      engineAction: result.action,
    });
    return parsed;
}

async function main() {
  if (HELP) {
    line('usage: node model-lane/pass.mjs [--dry-run] [--keep]');
    return 0;
  }
  const pipeline = readPipeline();
  const prompts = resolvePrompts();
  for (const role of ['writer', 'editor', 'consultant']) {
    const section = prompts[SECTION_OF_ROLE[role]];
    if (!section.ok) throw new LaneError('PROMPTS_MALFORMED', `${role}: ${section.reason}`);
  }
  // Read once, at the start: the evidence's `commit`/`dirty` describe the tree the pass started
  // on, not the one its own evidence directory has since made dirty.
  const origin = readProvenance();
  // ROLE_PROMPTS §4: «brief = the invariants, §1 verbatim, the lane and the slot». The invariants
  // are read once and put in front of every role's section — a pass without them is a different
  // prompt than prod's.
  const invariants = resolveInvariants();
  if (!invariants.ok) throw new LaneError('PROMPTS_MALFORMED', invariants.reason);
  // The key first on a live run: a missing key must not boot a process, let alone spend.
  if (!DRY_RUN) readKey();
  line(`pipeline: ${pipeline.model} → ${pipeline.apiModel}`);
  line(`prompts: §1 ${prompts['1'].sectionSha256.slice(0, 12)} · §2 ${prompts['2'].sectionSha256.slice(0, 12)} · §3 ${prompts['3'].sectionSha256.slice(0, 12)}`);
  line(`invariants: ${invariants.text.length} chars · ${invariants.sha256.slice(0, 12)}`);

  const scratch = await openScratch();
  const calls = [];
  try {
    const assignment = scratch.call(['next', '--for', 'fwd']);
    if (assignment === null) throw new LaneError('LANE_UNEXPECTED_PASS', 'the engine offered no forward assignment');
    if (assignment.pass !== 'draft' || typeof assignment.chapter !== 'number') {
      throw new LaneError(
        'LANE_UNEXPECTED_PASS',
        `the forward lane offered a ${String(assignment.pass)} pass on ${String(assignment.chapter)}, not a draft`,
      );
    }
    line(`claimed ${assignment.pass} ch${String(assignment.chapter)} · lease ${String(assignment.leaseId).slice(0, 12)}…`);

    // `start` first, always: it snapshots `start_sha` and the pre-write blocks from the file as it
    // is **right now**; called after the write, `land` compares the text with itself and reports
    // `changed:false` (the 2026-10-27 failure). Prod order: next → start → write → land.
    scratch.call(['start', assignment.leaseId]);
    line(`start ${String(assignment.leaseId).slice(0, 12)}… · start_sha snapshotted before the write`);

    if (DRY_RUN) {
      // Plumbing without a provider: the claim → start order, then the step is escalated closed.
      scratch.call(['escalate', assignment.leaseId, '--because', 'model lane dry run: plumbing only']);
      line(provenanceLine(origin));
      line('escalate · dry run: claimed, started, escalated — no call, no transcript');
      return 0;
    }

    const startedAt = new Date().toISOString();
    const runId = newRunId();
    lastRun.state = { pipeline, runId, startedAt, calls, origin, written: false };
    const writerAnswer = await complete(pipeline, writerMessages(scratch.bookRoot, invariants, prompts, assignment));
    const { prose, answerUnwrapped, answerTrimmed } = writerAnswer.empty
      ? { prose: '', answerUnwrapped: false, answerTrimmed: false }
      : toProse(writerAnswer.text);
    calls.push({
      role: 'writer',
      status: writerAnswer.empty ? 'error' : 'ok',
      ...(writerAnswer.empty
        ? { error: 'WRITER_EMPTY', reason: `the writer answered nothing (finish_reason ${writerAnswer.finishReason ?? 'absent'})`, answerHead: '' }
        : {}),
      chapter: assignment.chapter,
      stepId: assignment.stepId,
      leaseId: assignment.leaseId,
      ...callFacts(writerAnswer, pipeline, prompts['1'], invariants),
      answerUnwrapped,
      answerTrimmed,
      chars: prose.length,
    });
    if (writerAnswer.empty) {
      // The call was billed and produced nothing: a pass that did not write, not a lane that
      // could not run — exit 1, with the finish reason in the message (usually `length`).
      throw new LaneError(
        'WRITER_EMPTY',
        `the writer answered nothing (finish_reason ${writerAnswer.finishReason ?? 'absent'}, ` +
          `reasoning ${String(writerAnswer.reasoningTokens)} tokens); nothing landed`,
        1,
      );
    }
    if (prose.length < CHAPTER_FLOOR) {
      // A truncated pass is a product finding (chunked writing), never a smaller test: the lane
      // does not pad, does not lower the floor, and does not paraphrase the brief.
      throw new LaneError(
        'WRITER_TOO_SHORT',
        `the writer produced ${String(prose.length)} characters, below CHAPTER_CHARS.floor ${String(CHAPTER_FLOOR)} — nothing landed`,
        1,
      );
    }

    writeFileSync(join(scratch.bookRoot, 'manuscript', chapterName(assignment.chapter)), `${prose}\n`, 'utf8');
    let landed;
    try {
      landed = scratch.call(['land', assignment.leaseId]);
    } catch (error) {
      // A refused landing after the writer answered is a pass that did not close (the text was
      // too long, or the engine found nothing to land) — exit 1, not «the lane could not run».
      if (error instanceof LaneError) throw new LaneError(error.code, error.message, 1);
      throw error;
    }
    if (landed.changed !== true) {
      throw new LaneError('WRITER_NO_CHANGE', 'land reported no change: the copy already held that text', 1);
    }
    calls[0].landedSha = landed.sha;
    const frameOpening = frameCheck(scratch.bookRoot);
    line(
      `landed ch${String(assignment.chapter)} · rev ${String(landed.revAfter)} · ${String(prose.length)} chars · ` +
        `frameOpening ${String(frameOpening)}`,
    );

    const editor = await answerGate({ scratch, prompts, pipeline, invariants, calls }, 'editor');
    const consultant = await answerGate({ scratch, prompts, pipeline, invariants, calls }, 'consultant');
    line(`gates: editor ${editor.verdict} · consultant ${consultant.verdict}`);

    const closed = scratch.call([
      'done',
      assignment.leaseId,
      '--model',
      pipeline.model,
      '--tokens-in',
      String(writerAnswer.usage.in),
      '--tokens-out',
      String(writerAnswer.usage.out),
      '--note',
      `lane pass · ch${String(assignment.chapter)} · ${String(writerAnswer.usage.in)} in / ${String(writerAnswer.usage.out)} out`,
    ]);
    calls.at(0).outcome = closed.outcome;

    // The proof the pass closed comes from the engine's own `trace`, and its exact lines go into
    // the transcript (review, AC2). `assertClosedTrace` lives with the CLI it reads.
    const { closedLine, gateLine, stepModel } = assertClosedTrace(
      scratch.cli(['trace', assignment.stepId]).stdout,
      pipeline.model,
    );
    if (closed.outcome === 'escalated') {
      throw new LaneError('PASS_ESCALATED', `the step closed escalated instead of closing the pass`, 1);
    }

    const written = writeEvidence({
      mode: 'pass',
      runId,
      run: 'pass',
      startedAt,
      finishedAt: new Date().toISOString(),
      pipeline,
      calls,
      origin,
      extra: {
        stepId: assignment.stepId,
        leaseId: assignment.leaseId,
        chapter: assignment.chapter,
        invariantsSha256: invariants.sha256,
        invariantsChars: invariants.text.length,
        // What the landed chapter did with the frozen frame (a fact for F029, not a verdict).
        frameOpening,
        // The engine's own account of the close, verbatim from `bin/engine.mjs trace`: no
        // literal in place of what the engine said (review, AC2).
        stepModel,
        closedLine,
        gateLine,
        outcome: closed.outcome,
        changeStatus: closed.changeStatus,
        trace: { closed: true },
      },
    });
    lastRun.state.written = true;
    // The transcript is on disk: a bug in this line must not turn a closed pass into «could not
    // run» — the file the owner reads is already written.
    try {
      const reasoning = calls.reduce((sum, call) => sum + (call.reasoningTokens ?? 0), 0);
      const incomplete = calls.filter((call) => call.streamComplete === false).length;
      const finishes = calls.map((call) => `${call.role}:${call.finishReason ?? '—'}`).join(' ');
      line(
        `closed: ${String(closed.outcome)} · gates editor ${editor.verdict} / consultant ${consultant.verdict} · ` +
          `cost $${written.totals.costUsd.toFixed(6)} · ${utcStamp()} · ${written.path}`,
      );
      line(
        `answers: ${finishes} · reasoning ${String(reasoning)} tokens · incomplete streams ${String(incomplete)} · ` +
          `max_tokens ${String(pipeline.maxOutputTokens)}`,
      );
      line(provenanceLine(origin));
    } catch (error) {
      console.error(`model-lane: REPORT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`model-lane: evidence is written at ${written.path}`);
    }
    return 0;
  } finally {
    const state = await scratch.stop({ keep: KEEP });
    if (state.checkoutBefore !== state.checkoutAfter) {
      line('checkout changed during the run — the copy is the only writable root; investigate');
    }
    if (KEEP) line(`kept: ${scratch.dataDir} · ${scratch.bookRoot}`);
  }
}

/**
 * The last paid run, kept module-level so a failure **after** the first call still leaves a
 * transcript: an empty writer or a malformed gate answer has already spent money, and «no file
 * at all» is how one paid run's answers were lost (BOOK-62, 2026-10-27).
 */
const lastRun = { state: null };

/**
 * Only the entrypoint runs the pass: `node model-lane/pass.mjs` is the lane, and a check that
 * imports this module (to assert the assembled prompt without spending) must not start one.
 */
const entrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** A failed run that already called the provider writes what it has, then the caller exits. */
function failureEvidence(code) {
  return writeFailureTranscript({ mode: 'pass', state: lastRun.state, code });
}

if (entrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const code = error instanceof LaneError ? error.code : 'LANE_INTERNAL';
      console.error(`model-lane: ${code}: ${error instanceof Error ? error.message : String(error)}`);
      const path = failureEvidence(code);
      if (path !== null) console.error(`model-lane: evidence for the failed run is written at ${path}`);
      process.exitCode = error instanceof LaneError ? error.exitCode : 2;
    });
}

export { frameCheck };
export { gateMessages, systemTurn, writerMessages } from './prompts.mjs';
