/**
 * scripts/lib/position-gate.mjs — the age gate, answered the way a reader answers it (BOOK-225).
 *
 * Main added the gate while this branch was in review, and it changes what a **fresh browser
 * context** sees: the page stands `AgeGate` where the chapters would be — no slots, no prose —
 * until the reader answers. The contents sheet is *not* behind it (`TableOfContents` renders
 * beside the gate), so a harness that waited for `a.toc-link` rows would see forty-two of them on
 * a page that has no chapter at all, and would measure nothing row after row.
 *
 * So the harness answers the gate, once per context:
 *
 *   1. the answer is the reader's own act — a real click on `button.gate-go`, never a cookie the
 *      harness forges (a forged one would prove nothing about the page's own boot path);
 *   2. `POST /api/age` writes a cookie, and the context's jar keeps it: every later load of that
 *      context finds the gate already open and asks nothing, so the sweep's 84 loads click once;
 *   3. the page **boots** before it decides (`BootWait` is neither gate nor chapters), so the state
 *      after a navigation is read by waiting for the decision, never by one evaluate;
 *   4. the chapter list mounting — 42 consecutive `article[data-n]` slots — is the only readiness
 *      accepted here; the gate's disappearance is not evidence of a page.
 *
 * A page that still shows the gate after the answer is a **harness** failure (exit 2), never a row
 * miss: the layer was not measured, so no number about it exists to fail. The one honest exception
 * is the read budget refusing the `POST /api/age` — the same `429` the harness already retries
 * once after `retry-after`, bounded, and then reports.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import * as page from './position-page.mjs';

/** How long a booted page may take to show its gate or its chapters, and a gate to be answered. */
export const GATE_WAIT_MS = 15_000;

function harnessError(message) {
  return Object.assign(new Error(message), { harness: true });
}

/** The browser's own answer to `/api/age` for this session: recorded, never guessed. */
const gateAnswers = new WeakMap();

function watchGate(cdp) {
  const held = gateAnswers.get(cdp);
  if (held !== undefined) return held;
  const box = { answer: null };
  gateAnswers.set(cdp, box);
  cdp.on('Network.responseReceived', (params) => {
    const url = String(params?.response?.url ?? '');
    if (!url.endsWith('/api/age')) return;
    const headers = params.response.headers ?? {};
    box.answer = { status: params.response.status, retryAfter: headers['retry-after'] ?? headers['Retry-After'] ?? null };
  });
  return box;
}

/** Is the chapter list on the page — the contents, its rows, and a slot per chapter? */
function listed(state, totalRows) {
  return state.toc === true && state.rows === totalRows && state.articles >= totalRows;
}

/**
 * Wait for the page to decide: the gate to answer, or the chapter list it stands in front of.
 * Anything else — the boot, a blank document — is neither, and is waited out.
 */
async function waitForDecision(cdp, totalRows) {
  const started = Date.now();
  let seen = { toc: false, rows: 0, articles: 0 };
  for (;;) {
    if ((await cdp.evaluate(page.gate())).present === true) return { kind: 'gate' };
    seen = await cdp.evaluate(page.chapters());
    if (listed(seen, totalRows)) return { kind: 'chapters', ...seen };
    if (Date.now() - started > GATE_WAIT_MS) return { kind: 'timeout', ...seen };
    await sleep(100);
  }
}

/** Wait for the chapter list once the answer is in flight, or for an answer that will not mount it. */
async function waitForChapters(cdp, box, totalRows) {
  const started = Date.now();
  let seen = { toc: false, rows: 0, articles: 0 };
  for (;;) {
    seen = await cdp.evaluate(page.chapters());
    if (listed(seen, totalRows)) return { ...seen, ready: true };
    // A refused answer is not retried by the page: whatever its status, the gate stays standing.
    if (box.answer !== null && box.answer.status !== 200) return { ...seen, ready: false };
    if (Date.now() - started > GATE_WAIT_MS) return { ...seen, ready: false };
    await sleep(100);
  }
}

/**
 * Answer the gate on the page just loaded. A page without one — every load after the first in a
 * context, and any tree older than BOOK-225 — waits for its chapters and clicks nothing.
 */
export async function acknowledgeGate(cdp, log, totalRows) {
  const box = watchGate(cdp);
  const decision = await waitForDecision(cdp, totalRows);
  if (decision.kind === 'chapters') return;
  if (decision.kind === 'timeout') {
    throw harnessError(
      `the page showed neither its age gate nor its ${String(totalRows)} chapters in ` +
        `${String(Math.round(GATE_WAIT_MS / 1000))} s (${String(decision.rows)} contents rows, ` +
        `${String(decision.articles)} slots) — the harness cannot measure it`,
    );
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    box.answer = null;
    const clicked = await cdp.evaluate(page.gateAccept());
    if (clicked.clicked !== true) {
      // A click already in flight (the button disables while it posts): give it its own moment.
      await sleep(500);
      continue;
    }
    const state = await waitForChapters(cdp, box, totalRows);
    if (state.ready) {
      log(`gate: answered on attempt ${String(attempt)} — ${String(state.rows)} chapters`);
      return;
    }
    if (box.answer !== null && box.answer.status === 429 && attempt === 1) {
      const seconds = Number(box.answer.retryAfter ?? '1');
      const wait = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 15) : 1;
      log(`  429 from /api/age — one retry in ${String(wait)} s`);
      await sleep(wait * 1_000);
      continue;
    }
    const why = box.answer === null ? 'no answer from /api/age' : `/api/age answered ${String(box.answer.status)}`;
    throw harnessError(
      `the age gate still stands after the reader’s answer (${why}) — ` +
        `the page never reached its ${String(totalRows)} chapters`,
    );
  }
}
