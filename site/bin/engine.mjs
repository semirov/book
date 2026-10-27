#!/usr/bin/env node
/**
 * bin/engine.mjs — the session protocol of the writing engine (ARCHITECTURE.md §6A.11).
 *
 * The CLI is a thin client of the engine's internal API: a writer session claims a job,
 * touches the leased file, reports it, and two gate sessions answer. It never reads
 * `book.db` directly and never writes anywhere.
 *
 *   engine.mjs next --for fwd|bwd            → a writer assignment (or null)
 *   engine.mjs next --role editor|consultant → a gate assignment (or null)
 *   engine.mjs pass --chapter N [--session S] → a first pass for that chapter (BOOK-117 §4)
 *   engine.mjs next --role rights            → Gate B's assignment, for a flagged step (or null)
 *   engine.mjs start <leaseId> [--decision adapt|drop|void --reason … [--intent …]]
 *   engine.mjs land <leaseId> [--rev N] [--no-write]
 *   engine.mjs verdict <stepId> --role editor|consultant --session S --verdict HOLDS|GAP --model M
 *                              [--findings findings.json] [--tokens-in N] [--tokens-out N]
 *   engine.mjs verdict <stepId> --role rights [--session S] --verdict CLEAR|REFUSED [--rule <id>]
 *   engine.mjs done <leaseId> --model M [--seams seams.json] [--note "…"] [--tokens-in N] [--tokens-out N]
 *   engine.mjs seen <leaseId> --model M [--note "…"] [--tokens-in N] [--tokens-out N]
 *   engine.mjs escalate <leaseId> --because "…"
 *   engine.mjs beat <leaseId>
 *   engine.mjs trace <changeId|stepId>
 *   engine.mjs reconcile [chapter --because "…"]   without a chapter: the maintenance pass
 *
 * Environment: ENGINE_URL (default http://127.0.0.1:8081), ENGINE_TOKEN or ENGINE_TOKEN_FILE
 * (default site/.data/engine.token), ENGINE_SESSION (default: the lane or role name).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: engine.mjs <next|pass|start|land|verdict|done|seen|escalate|beat|trace|reconcile> [args]';

function parse(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'no-write' || name === 'help') {
      flags.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag --${name} needs a value`);
    }
    flags.set(name, value);
    index += 1;
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

function readToken() {
  if (process.env.ENGINE_TOKEN) return process.env.ENGINE_TOKEN.trim();
  const file = process.env.ENGINE_TOKEN_FILE ?? join(SITE_ROOT, '.data', 'engine.token');
  const path = isAbsolute(file) ? file : resolve(SITE_ROOT, file);
  if (!existsSync(path)) {
    throw new Error(`engine token not found: ${path} (start the engine once, or set ENGINE_TOKEN)`);
  }
  return readFileSync(path, 'utf8').trim();
}

async function call(path, body) {
  const base = (process.env.ENGINE_URL ?? 'http://127.0.0.1:8081').replace(/\/+$/u, '');
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken()}` },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    throw new Error(`engine unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null || payload.ok !== true) {
    const code = payload?.code ?? `HTTP_${response.status}`;
    const message = payload?.message ?? 'request failed';
    const detail = payload?.detail ? `\n${JSON.stringify(payload.detail, null, 2)}` : '';
    const error = new Error(`${code}: ${message}${detail}`);
    error.refused = true;
    throw error;
  }
  return payload.data;
}

function readJsonArgument(flags, name, fallback) {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  const raw = value.trim().startsWith('{') || value.trim().startsWith('[')
    ? value
    : readFileSync(resolve(value), 'utf8');
  return JSON.parse(raw);
}

function numberFlag(flags, name) {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function session(flags, fallback) {
  return flags.get('session') ?? process.env.ENGINE_SESSION ?? fallback;
}

/**
 * ADR-038 (BOOK-62): a prose step's model is required, and the CLI refuses locally without it —
 * the engine refuses the same way (`MODEL_REQUIRED`, 422), but a session that forgot the flag
 * should learn it from its own terminal, not from a round trip. Exit 1: a local usage error.
 */
function modelFlag(flags) {
  const model = flags.get('model');
  if (model === undefined || model.trim().length === 0) throw new Error('--model is required');
  return model;
}

function renderSeams(seams) {
  if (!Array.isArray(seams) || seams.length === 0) return '—';
  return seams.map((seam) => `${seam.boundary} (${seam.reason})`).join('; ');
}

/** ` · model deepseek/…`, or nothing when the row has none (an escalation claims no text). */
function renderModel(model) {
  return ` · model ${model ?? '—'}`;
}

function renderGates(gates, withLate) {
  const rendered = gates.map(
    (gate) =>
      `${gate.role}:${gate.verdict}${gate.late && withLate ? ' (late)' : ''} [${gate.model ?? '—'}]`,
  );
  return `gates: ${rendered.join(' · ') || 'none'}`;
}

function renderTrace(trace) {
  if (trace === null) return 'nothing found';
  if (trace.kind === 'step') {
    // `trace.step` is the `StepTrace`: `{step, gates}` — the row is nested one level down, and
    // reading `trace.step.stepId` printed `undefined` for every field but `gates` (BOOK-62).
    const step = trace.step.step;
    return [
      `step ${step.stepId} · ${step.pass} · ${step.state}${step.outcome ? ` · ${step.outcome}` : ''}` +
        ` · chapter ${step.chapter ?? 'front'} · wave ${step.wave}${renderModel(step.model)}`,
      `  ${renderGates(trace.step.gates, true)}`,
      // BOOK-61: Gate B is conditional and has its own enum — one line, never a third gate.
      ...(trace.step.rights === null
        ? []
        : [`  rights: ${trace.step.rights.verdict}${trace.step.rights.rule === null ? '' : ` ${trace.step.rights.rule}`}`]),
      `  seams in: ${renderSeams(step.seamsIn)}`,
      `  seams out: ${renderSeams(step.seamsOut)}`,
      `  tokens: ${step.tokensIn}/${step.tokensOut} · session ${step.session ?? '—'}`,
    ].join('\n');
  }
  const change = trace.change.change;
  const lines = [
    `change ${change.id} #${change.seq} · chapter ${change.chapter} · ${change.status}${change.outcome ? ` · ${change.outcome}` : ''}${change.premise ? ' · premise' : ''}${renderModel(change.model)}`,
    `  intent: ${change.intent}`,
    change.premise && change.status === 'pending'
      ? `  premise: waits for chapter ${change.chapter}'s first draft pass — not in the lane`
      : null,
    change.reason ? `  reason: ${change.reason}` : null,
    change.relevance
      ? `  relevance: ${change.relevance.grade} (rev ${change.relevance.revAtRecord} → ${change.relevance.revNow}, overlap ${change.relevance.overlap})`
      : null,
  ].filter((line) => line !== null);
  if (trace.change.cascade === null) {
    lines.push('  cascade: none');
    return lines.join('\n');
  }
  const cascade = trace.change.cascade;
  lines.push(
    `  cascade ${cascade.id} · ${cascade.status}${cascade.outcome ? ` · ${cascade.outcome}` : ''}` +
      ` · waves ${cascade.wave} · depth ←${cascade.depthBackward} →${cascade.depthForward} · steps ${cascade.steps.length}`,
  );
  for (const step of cascade.steps) {
    lines.push(
      `    #${step.step.seq} w${step.step.wave} ${step.step.pass}/${step.step.lane ?? '—'} ch${step.step.chapter ?? 'front'}` +
        ` · ${step.step.outcome ?? 'open'} · rev ${step.step.revBefore ?? '—'}→${step.step.revAfter ?? '—'}` +
        `${renderModel(step.step.model)} · ${renderGates(step.gates, false)}` +
        `${step.rights === null ? '' : ` · rights ${step.rights.verdict}`}`,
    );
    lines.push(`       seams in ${renderSeams(step.step.seamsIn)} · out ${renderSeams(step.step.seamsOut)}`);
  }
  return lines.join('\n');
}

async function main() {
  const { command, positionals, flags } = parse(process.argv.slice(2));
  if (flags.get('help') || command === null) {
    console.log(USAGE);
    return;
  }
  const need = (index, what) => {
    const value = positionals[index];
    if (!value) throw new Error(`${what} is required`);
    return value;
  };

  switch (command) {
    case 'next': {
      const lane = flags.get('for');
      const role = flags.get('role');
      if ((lane === undefined) === (role === undefined)) throw new Error('pass exactly one of --for|--role');
      const assignment = await call('/internal/next', {
        for: lane,
        role,
        session: session(flags, lane ?? role),
      });
      console.log(JSON.stringify(assignment, null, 2));
      return;
    }
    case 'pass': {
      // BOOK-117 §4: open the first pass of one named chapter instead of the lane's own next
      // slot — the owner's premise waits in chapter 65, and a lane would reach it in ~60 passes.
      const chapter = numberFlag(flags, 'chapter');
      if (chapter === undefined || !Number.isInteger(chapter) || chapter < 1 || chapter > 67) {
        throw new Error('--chapter 1..67 is required');
      }
      const assignment = await call('/internal/pass', {
        chapter,
        session: session(flags, `pass-${chapter}`),
      });
      console.log(JSON.stringify(assignment, null, 2));
      return;
    }
    case 'start': {
      const leaseId = need(0, 'leaseId');
      const result = await call('/internal/start', {
        leaseId,
        decision: flags.get('decision'),
        reason: flags.get('reason'),
        intent: flags.get('intent'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'land': {
      const leaseId = need(0, 'leaseId');
      const result = await call('/internal/land', {
        leaseId,
        noWrite: flags.get('no-write') === true,
        rev: numberFlag(flags, 'rev'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'verdict': {
      const stepId = need(0, 'stepId');
      const role = flags.get('role');
      if (role !== 'editor' && role !== 'consultant' && role !== 'rights') {
        throw new Error('--role editor|consultant|rights is required');
      }
      const verdict = flags.get('verdict');
      // BOOK-61: Gate B answers with its own enum and names a rule id (never a sentence).
      if (role === 'rights') {
        if (verdict !== 'CLEAR' && verdict !== 'REFUSED') throw new Error('--verdict CLEAR|REFUSED is required');
        const result = await call('/internal/verdict', {
          stepId,
          role,
          session: session(flags, role),
          verdict,
          rule: flags.get('rule'),
          model: flags.get('model'),
          tokensIn: numberFlag(flags, 'tokens-in'),
          tokensOut: numberFlag(flags, 'tokens-out'),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (verdict !== 'HOLDS' && verdict !== 'GAP') throw new Error('--verdict HOLDS|GAP is required');
      const model = modelFlag(flags);
      const result = await call('/internal/verdict', {
        stepId,
        role,
        session: session(flags, role),
        verdict,
        findings: readJsonArgument(flags, 'findings', []),
        model,
        tokensIn: numberFlag(flags, 'tokens-in'),
        tokensOut: numberFlag(flags, 'tokens-out'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'done': {
      const leaseId = need(0, 'leaseId');
      const model = modelFlag(flags);
      const result = await call('/internal/done', {
        leaseId,
        seams: readJsonArgument(flags, 'seams', []),
        note: flags.get('note'),
        model,
        tokensIn: numberFlag(flags, 'tokens-in'),
        tokensOut: numberFlag(flags, 'tokens-out'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'seen': {
      const leaseId = need(0, 'leaseId');
      const model = modelFlag(flags);
      const result = await call('/internal/seen', {
        leaseId,
        note: flags.get('note'),
        model,
        tokensIn: numberFlag(flags, 'tokens-in'),
        tokensOut: numberFlag(flags, 'tokens-out'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'escalate': {
      const leaseId = need(0, 'leaseId');
      const because = flags.get('because');
      if (!because) throw new Error('--because "…" is required');
      const result = await call('/internal/escalate', { leaseId, because });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'beat': {
      const result = await call('/internal/beat', { leaseId: need(0, 'leaseId') });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'trace': {
      const trace = await call('/internal/trace', { id: need(0, 'changeId|stepId') });
      console.log(renderTrace(trace));
      return;
    }
    case 'reconcile': {
      // §13.3: `reconcile 9 --because "restore rev 3"` marks the restore and re-runs the
      // gates; without a chapter it is the engine's maintenance pass over leaked leases.
      const chapter = positionals[0];
      if (chapter === undefined) {
        const report = await call('/internal/reconcile', {});
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (!Number.isInteger(Number(chapter))) throw new Error('chapter must be an integer 1..67');
      const because = flags.get('because');
      if (!because) throw new Error('--because "…" is required with a chapter: say why the restore stands');
      const report = await call('/internal/reconcile', {
        chapter: Number(chapter),
        because,
        actor: flags.get('actor') ?? process.env.ENGINE_ACTOR ?? 'operator',
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    default:
      throw new Error(`unknown command: ${command}\n${USAGE}`);
  }
}

main().catch((error) => {
  const refused = error && typeof error === 'object' && error.refused === true;
  console.error(`engine: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(refused ? 2 : 1);
});
