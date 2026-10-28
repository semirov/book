/**
 * The harness's own end-to-end check, with **no network and no key**: `npx tsx scripts/experiments/selftest.ts`.
 *
 * A fake provider answers every command with a canned SSE stream — a short chapter for the
 * writing calls, `HOLDS` for the gates, anything for the cache calls — so the whole pipeline
 * (prompt build → call → parse → validate → diff → artifact → gates → cache → summary) runs
 * exactly as it will against the real API, and a bug that would have burned a pass shows up
 * for free. The real key is never read: the fake sits under the same `DEEPSEEK_API_KEY_FILE`
 * seam the harness uses, holding a value that is not a credential.
 *
 * Artifacts go to `site/.data/experiments/selftest/` (`EXPERIMENTS_DIR`), never among the real
 * rows; the wait between a warm and a hit is 10 ms (`EXPERIMENTS_WAIT_MS`), because the fake
 * ignores the cache.
 *
 * Two phases, because the run has two shapes: `all` measures the three filings, `all --control`
 * measures the seeded promise/deadline fixture that makes a ripple happen at all. Both are driven
 * through the CLI's own `main()`, with `EXPERIMENTS_NO_MAIN=1` so the import does not run it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const STATE_DIR = join(ROOT, 'site', '.data', 'experiments', 'selftest');
const KEY_FILE = join(STATE_DIR, 'fake.key');

/**
 * Long enough for `CHAPTER_CHARS.floor`, three-plus paragraphs, no wall, no markdown. ch01 must
 * open on the frozen first sentence (`validateAnswer` says so), so the fake writes one for it.
 */
function chapterText(opensOnFrame: boolean): string {
  const first = Array.from({ length: 6 }, (_, index) =>
    [
      `Абзац ${String(index + 1)}. Я вошёл в комнату, где пахло мокрой штукатуркой и чужой капустой,`,
      'и подумал, что заявление лучше держать во внутреннем кармане, пока не позовут.',
      'Тоня сказала, что по радио обещали мокрый снег, и велела надеть вторые носки.',
      'Я кивнул и пересчитал листки: их было семь, и нижний сгиб потемнел, как старый шрам.',
    ].join(' '),
  );
  if (opensOnFrame) first[0] = `${FRAME_FIRST_SENTENCE} ${first[0] ?? ''}`;
  return ['Проверочный текст', '', ...first].join('\n\n');
}

function frame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function stream(text: string, usage: Record<string, unknown>): Response {
  const frames = [
    frame({ model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    frame({ model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    frame({ model: 'deepseek-v4-pro', choices: [], usage }),
    new TextEncoder().encode('data: [DONE]\n\n'),
  ];
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= frames.length) {
          controller.close();
          return;
        }
        const chunk = frames[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        index += 1;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const calls: Array<{ maxTokens: number; system: string; chars: number }> = [];

const DATE = /(\d{2})\.(\d{2})\.(\d{4})/u;

/**
 * A patch a real applier will accept: one block, `oldText` copied from the prompt's own printed
 * block. A block that carries a date gets the date moved by a week — that is what makes the plan
 * see a `value` move and the ripple happen; without one, `oldText` plus a word, so nothing is
 * removed and no fact or dangling reference can be manufactured by the fixture.
 */
function patchFrom(body: string): string {
  const lines = body.split('\n');
  const blocks: Array<{ id: string; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^### (ch\d+#\S+)$/u.exec(lines[index] ?? '');
    if (match === null) continue;
    const text = (lines[index + 1] ?? '').trim();
    if (text.length > 0) blocks.push({ id: match[1] ?? '', text });
  }
  // A date first: moving it is what makes the plan see a `value` move and the ripple happen.
  for (const block of blocks.slice(1)) {
    const date = DATE.exec(block.text);
    if (date === null) continue;
    const day = Math.min(28, Number(date[1]) + 7);
    return JSON.stringify({
      mode: 'patch',
      edits: [
        { blockId: block.id, oldText: date[0], newText: `${String(day).padStart(2, '0')}.${date[2] ?? '01'}.${date[3] ?? '2065'}` },
      ],
      facts: [],
      note: 'selftest fixture: a date moved',
    });
  }
  // Otherwise `oldText` plus a word: nothing removed, so no fact and no dangling reference is
  // manufactured by the fixture, and the applier's invariants stay satisfied.
  for (const block of blocks.slice(1)) {
    if (block.text.length < 60) continue;
    const oldText = block.text.slice(0, 40);
    return JSON.stringify({
      mode: 'patch',
      edits: [{ blockId: block.id, oldText, newText: `${oldText} Точка.` }],
      facts: [],
      note: 'selftest fixture',
    });
  }
  return JSON.stringify({ mode: 'rewrite', edits: [], facts: [], note: 'no patchable block found' });
}


async function fakeFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = JSON.parse(String(init?.body ?? '{}')) as {
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
  };
  const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
  const chars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  calls.push({ maxTokens: request.max_tokens, system: system.slice(0, 40), chars });
  const body = request.messages.map((message) => message.content).join('\n');
  // A gate prompt is the one that quotes the chapter it judges; the role fence itself is prose.
  const gate = body.includes('## Просмотренная глава');
  const patchAnswer = body.includes('## Абзацы этой главы, с id');
  const text =
    request.max_tokens === 64 ? 'ok' : gate ? 'HOLDS' : patchAnswer ? patchFrom(body) : chapterText(body.includes('Глава 1 из 42'));
  const cachedIn = request.max_tokens === 64 ? Math.floor(chars / 8) : 0;
  return stream(text, {
    prompt_tokens: Math.floor(chars / 6),
    completion_tokens: Math.floor(text.length / 6),
    prompt_cache_hit_tokens: cachedIn,
    prompt_cache_miss_tokens: Math.max(0, Math.floor(chars / 6) - cachedIn),
    prompt_tokens_details: { cached_tokens: cachedIn },
  });
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  // Not a credential: the fake provider ignores it and the real key is never opened.
  writeFileSync(KEY_FILE, 'selftest-not-a-key\n', 'utf8');
  process.env.EXPERIMENTS_DIR = STATE_DIR;
  process.env.EXPERIMENTS_WAIT_MS = '10';
  process.env.DEEPSEEK_API_KEY_FILE = KEY_FILE;
  process.env.EXPERIMENTS_NO_MAIN = '1';
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  const { main } = await import('./run.ts');

  // Phase 1: the three filings. Phase 2: the seeded fixture that makes a ripple happen.
  process.argv = ['node', 'run.ts', 'all'];
  await main();
  process.argv = ['node', 'run.ts', 'all', '--control'];
  await main();
  // Phase 3: the dry run — the closure table must exist even with zero calls.
  process.argv = ['node', 'run.ts', '--dry'];
  await main();

  const summary = readJson(join(STATE_DIR, 'summary.json'));
  const failures: string[] = [];
  const expect = (name: string, ok: boolean): void => {
    if (!ok) failures.push(name);
  };
  expect('summary.json written', summary !== null);
  const rows = Array.isArray(summary?.rows) ? (summary?.rows as unknown[]) : [];
  expect('the A/B rows are there (three filings × two modes, plus the control)', rows.length >= 6);
  const cache = Array.isArray(summary?.cache) ? (summary?.cache as unknown[]) : [];
  expect('seven cache calls (W1, H0, H1, H2, H3, H4a, H4b)', cache.length === 7);
  expect('no secret in the summary', !JSON.stringify(summary ?? {}).includes('selftest-not-a-key'));
  expect('calls were made through the seam', calls.length > 0);
  const a = readJson(join(STATE_DIR, 'ab-A-ch01.json'));
  expect('A artifact has a landed text', typeof (a?.landed as { text?: unknown } | undefined)?.text === 'string');
  expect('A artifact has metrics', typeof a?.metrics === 'object' && a?.metrics !== null);
  const editor = readJson(join(STATE_DIR, 'gates-A-ch01-ch01-editor.json'));
  expect('the editor gate parsed HOLDS', (editor?.parsed as { verdict?: unknown } | undefined)?.verdict === 'HOLDS');
  const b = readJson(join(STATE_DIR, 'ab-B-ch03.json'));
  expect('B applied a patch and validated it', typeof (b?.landed as { text?: unknown } | undefined)?.text === 'string');
  expect('B is not blocked', typeof b?.blocked !== 'string');

  // The plan step: every A/B row carries a closure, and the closure is the plan's own numbers.
  const closure = (b?.closure ?? {}) as Record<string, unknown>;
  expect('B row carries a closure', typeof closure.closureNodes === 'number' && typeof closure.outcome === 'string');
  const plan = readJson(join(STATE_DIR, 'control-B-ch05.json'));
  expect('the control plan is a ripple', (plan?.plan as { outcome?: unknown } | undefined)?.outcome === 'ripple');
  expect('the control rippled into a second chapter', Array.isArray((plan?.ripple as { chapters?: unknown } | undefined)?.chapters) && ((plan?.ripple as { chapters: unknown[] }).chapters.length > 0));
  const wide = readJson(join(STATE_DIR, 'wide-ctl05.json'));
  expect('the wide row projects one chapter over the closure', typeof (wide?.metrics as { wideProjectionUsd?: unknown } | undefined)?.wideProjectionUsd === 'number');
  const gate = readJson(join(STATE_DIR, 'gates-B-ctl05-ch05-editor.json'));
  expect('the control chapter is gated', (gate?.parsed as { verdict?: unknown } | undefined)?.verdict === 'HOLDS');
  // The dry run writes the closures it printed: the research answer needs no model call.
  const dry = (() => {
    try {
      return readFileSync(join(STATE_DIR, 'summary-dry.md'), 'utf8');
    } catch {
      return '';
    }
  })();
  expect('the dry run writes the closure table', dry.includes('## closure') && dry.includes('ctl05'));

  const total = 16;
  for (const name of failures) process.stdout.write(`selftest FAILED: ${name}\n`);
  process.stdout.write(
    `selftest: ${String(total - failures.length)}/${String(total)} checks passed · ${String(calls.length)} fake calls · artifacts in site/.data/experiments/selftest/\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

await main();
