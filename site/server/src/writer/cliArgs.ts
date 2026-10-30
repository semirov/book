/**
 * The writer CLI's flags (`main.ts`, split at the arch bound): the usage text, the parsed shape
 * and the one pure function that turns `argv` into it — so a test proves a refusal without a
 * process.
 */

import { TOTAL_CHAPTERS } from '@book/shared';

export const USAGE = [
  'usage: writer [--once] [--chapter N] [--dry-run] [--revert --chapter N] [--loop] [--ripple] [--plan ID] [--audit-samples [N]]',
  '',
  '  --once            one triage pulse and one pass, then exit (default)',
  '  --chapter N       open the first pass for chapter N instead of the lane’s next slot',
  '  --dry-run         resolve config, assignment and prompt; no engine, no model, no writes',
  '  --revert --chapter N  put the chapter back to its pre-pass state, verify the sha, reconcile',
  '  --loop            one pass, then pause (WRITER_PAUSE_MS), until SIGTERM',
  '  --ripple          drain the oldest ripple still owed work (BOOK-173), then exit',
  '  --plan ID         print the reviewable table of change ID’s ripple plan; nothing is written',
  '  --audit-samples [N]  re-read the queued local-only samples with the editor (default 3)',
  '  --help            this text',
].join('\n');

export type Cli = {
  mode: 'run' | 'revert' | 'help' | 'ripple' | 'plan' | 'audit';
  once: boolean;
  loop: boolean;
  dryRun: boolean;
  chapter: number | null;
  /** `--plan <changeId>`: the change whose frozen ripple plan is printed. */
  changeId: string | null;
  /** `--audit-samples [N]`: how many queued samples to re-read (`null` = the default). */
  audit: number | null;
};

export type ParsedArgs = { ok: true; cli: Cli } | { ok: false; error: string };

const VALUE_FLAGS = new Set(['chapter', 'plan']);
const BOOLEAN_FLAGS = new Set(['once', 'loop', 'dry-run', 'revert', 'help', 'ripple']);
/** A flag whose value is optional: `--audit-samples` alone takes the default, `=N` names a count. */
const OPTIONAL_VALUE_FLAGS = new Set(['audit-samples']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) return { ok: false, error: `unexpected argument: ${arg}` };
    const [rawName, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const name = rawName.trim();
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name) && !OPTIONAL_VALUE_FLAGS.has(name)) {
      return { ok: false, error: `unknown flag: --${name}` };
    }
    if (flags.has(name)) return { ok: false, error: `duplicate flag: --${name}` };
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return { ok: false, error: `flag --${name} takes no value` };
      flags.set(name, true);
      continue;
    }
    const next = argv[index + 1];
    if (OPTIONAL_VALUE_FLAGS.has(name) && inline === undefined && (next === undefined || next.startsWith('--'))) {
      flags.set(name, true);
      continue;
    }
    const value = inline ?? next;
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      return { ok: false, error: `flag --${name} needs a value` };
    }
    if (inline === undefined) index += 1;
    flags.set(name, value);
  }

  if (flags.has('help')) {
    return { ok: true, cli: { mode: 'help', once: true, loop: false, dryRun: false, chapter: null, changeId: null, audit: null } };
  }

  let chapter: number | null = null;
  if (flags.has('chapter')) {
    const raw = flags.get('chapter');
    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > TOTAL_CHAPTERS) {
      return { ok: false, error: `--chapter must be an integer between 1 and ${String(TOTAL_CHAPTERS)}` };
    }
    chapter = value;
  }

  const plan = flags.get('plan');
  if (plan !== undefined && typeof plan !== 'string') return { ok: false, error: '--plan needs a change id' };
  const changeId = typeof plan === 'string' ? plan : null;

  const auditFlag = flags.has('audit-samples');
  let audit: number | null = null;
  if (auditFlag) {
    const raw = flags.get('audit-samples');
    if (raw !== true) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) return { ok: false, error: '--audit-samples takes a positive integer' };
      audit = value;
    }
  }

  const revert = flags.has('revert');
  const ripple = flags.has('ripple');
  const loop = flags.has('loop');
  const once = flags.has('once');
  // The sample audit reads chapters and calls the editor: it is one command, not a pass.
  if (auditFlag && (revert || ripple || loop || chapter !== null || changeId !== null || once)) {
    return { ok: false, error: '--audit-samples runs alone: no chapter, no pass, no drain' };
  }
  if (revert && chapter === null) return { ok: false, error: '--revert needs --chapter N' };
  if (loop && once) return { ok: false, error: '--once and --loop are two different shapes' };
  if (loop && revert) return { ok: false, error: '--loop cannot revert' };
  if (ripple && revert) return { ok: false, error: '--ripple and --revert are two different shapes' };
  if (ripple && chapter !== null) return { ok: false, error: '--ripple chooses its own chapter from the plan' };
  if (changeId !== null && (revert || ripple || loop)) {
    return { ok: false, error: '--plan prints a table; it runs nothing' };
  }

  const mode = auditFlag ? 'audit' : changeId !== null ? 'plan' : ripple ? 'ripple' : revert ? 'revert' : 'run';
  return {
    ok: true,
    cli: { mode, once: !loop, loop, dryRun: flags.has('dry-run'), chapter, changeId, audit },
  };
}
