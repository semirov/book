/**
 * scripts/lib/position-measure.mjs — the browser half of BOOK-209's guard, kept out of the driver.
 *
 * Four measurements, each one reader act and one number: the contents landing (AC1), a back that
 * returns to the place (AC2), and the place a device remembers (AC3) — twice, because a place is
 * per reader: once on the device that kept it (`localStorage`) and once on a second browser
 * context that holds **only the session cookie**, which is the only way a second device can learn
 * it. Everything is measured in the page; nothing here re-implements the product, and the place
 * row the second device is given is the product's own row read back from its store.
 *
 * The functions take the CDP connection (or the browser handle) and answer plain objects. `log`
 * is the driver's `--verbose` sink; a step that only matters when something is wrong is silent.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp } from './cdp.mjs';
import * as boot from './position-boot.mjs';
import * as page from './position-page.mjs';
import { POSITION_TARGET_PX, POSITION_TOLERANCE_PX, round2 } from './position.mjs';

/** The book's slots: every contents row, empty ones included. */
export const TOTAL_ROWS = 42;

/**
 * One counter per load. The app pushes `#ch-N` into the address bar (a place jump is a history
 * entry), and `Page.navigate` to the bare origin from `/#ch-3` is a **fragment** navigation: the
 * document is not reloaded, so the next row would inherit the previous row's scroll, prose and
 * place layer. A unique query makes every row a real page load, which is what the record claims.
 */
let loads = 0;

function harnessError(message) {
  return Object.assign(new Error(message), { harness: true });
}

/**
 * One request, at most one retry, and only when the read limiter refused it: `retry-after` is
 * the server's own instruction, bounded here to a few seconds so a script cannot hang on a
 * budget that will not come back inside the run. Any other answer — including a second `429` —
 * is reported as it is, never retried into a pass.
 */
async function fetchRetry(url, init, log) {
  const answer = await fetch(url, init);
  if (answer.status !== 429) return answer;
  const seconds = Number(answer.headers.get('retry-after') ?? '1');
  const wait = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 15) : 1;
  log(`  429 from ${new URL(url).pathname} — one retry in ${String(wait)} s`);
  await sleep(wait * 1_000);
  return fetch(url, init);
}

/**
 * Navigate and wait for the page the harness measures: 42 rows, fonts settled.
 *
 * `fresh` makes the load a first visit: a place layer (BOOK-209) that resumes a device on every
 * load would otherwise land *after* a contents tap and be measured as the tap's landing. This is
 * fixture state, not product behaviour — the harness sets «a reader who has not read yet», and
 * says so in the record.
 *
 * A first visit is two removals, not one. The keys are removed **in the page that owns the
 * store**, synchronously, and only then the document navigates (a browser-level clear is answered
 * before the storage is actually gone, and a load that overtakes it resumes the previous row's
 * place). And the place **write** is blocked for the rest of that document's life: the product
 * writes its place on `pagehide` — and on a throttled timer that keeps the last scroll — so
 * clearing alone leaves the load that follows with a boot place. The product's resume then lands
 * on the first ready page, asynchronously (the sentence it names waits for its paragraph's prose),
 * and it outranks the harness's own programmatic scroll: a parked sentence moved 20 000 px
 * because the page was still landing the place of the document before it. A reader's gesture
 * cancels that resume (`usePosition`'s `INPUT_EVENTS`); a script's scroll is not one, so the
 * harness does not rely on the cancellation — it removes the place the resume would read.
 */
async function openPage(cdp, viewport, options = {}) {
  if (options.fresh === true) {
    await cdp
      .evaluate(`(() => {
        try {
          const place = /place/i;
          const keys = Object.keys(window.localStorage).filter((key) => place.test(key));
          for (const key of keys) window.localStorage.removeItem(key);
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function setItemOnce(key, value) {
            if (place.test(String(key))) return undefined;
            return setItem.call(this, key, value);
          };
          return keys.length;
        } catch {
          return -1;
        }
      })()`)
      .catch(() => undefined);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 600,
  });
  loads += 1;
  await cdp.send('Page.navigate', { url: `${boot.POSITION_ORIGIN}/?row=${String(loads)}` });
  await waitForApp(cdp);
  // The page a reader taps has painted: the row count and the fonts are not the whole layout
  // (a placeholder above the target can still be re-measured, and a row measured against a stale
  // height lands thousands of pixels off). Quiet means the scroll offset and the document's
  // height have held for three frames; then the tap is a tap on the page, not on a transition.
  await cdp.evaluate(page.settle({ budgetMs: 1500, stableFrames: 3, minMs: 400 }));
}

async function waitForApp(cdp) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const rows = await cdp.evaluate(page.rowCount()).catch(() => 0);
    if (rows === TOTAL_ROWS) {
      await cdp.evaluate(page.install());
      await cdp.evaluate('document.fonts.ready.then(() => true)');
      return;
    }
    await sleep(50);
  }
  throw harnessError(`the page never reached ${String(TOTAL_ROWS)} contents rows`);
}

/** AC1: one row per line, on its own page load, per width. */
export async function measureContents(cdp, viewport, rows, log) {
  const measured = [];
  for (const n of rows) {
    await openPage(cdp, viewport, { fresh: true });
    const sample = await cdp.evaluate(page.jump(n));
    if (sample.error !== undefined) throw harnessError(`contents row ${String(n)}: ${sample.error}`);
    const actual = sample.quiet ?? null;
    const delta = actual === null ? null : round2(actual - POSITION_TARGET_PX);
    const row = {
      row: n,
      width: viewport.width,
      head: sample.head,
      expected: POSITION_TARGET_PX,
      actual,
      delta,
      at150: sample.at150 ?? null,
      at800: sample.at800 ?? null,
      stable: sample.stable === true,
      prevented: sample.prevented === true,
      scrollY: sample.scrollY ?? null,
    };
    measured.push(row);
    process.stdout.write(
      `row ${String(n)} width ${String(viewport.width)} expected=${String(POSITION_TARGET_PX)} ` +
        `actual=${String(actual)} delta=${String(delta)} at150=${String(row.at150)} at800=${String(row.at800)}\n`,
    );
    log(`  head=${row.head} stable=${String(row.stable)} prevented=${String(row.prevented)} scrollY=${String(row.scrollY)}`);
  }
  return measured;
}

/** AC2: a sentence parked mid-viewport, away twice, back twice — same sentence, same offset? */
export async function measureBack(cdp, viewport, chapter, cases, log) {
  await openPage(cdp, viewport, { fresh: true });
  await cdp.evaluate(page.install());
  const measured = [];
  for (const item of cases) {
    const placed = await cdp.evaluate(page.place(chapter, item.index));
    if (placed.found !== true) {
      measured.push({ width: viewport.width, case: item.name, sentence: '', before: null, after: null, delta: null, found: false });
      process.stdout.write(`back case=${item.name} sentence= before= after= delta= found=no\n`);
      continue;
    }
    // One more quiet wait before the number is taken: the sentence must be where the reader left
    // it. The extra second is the product's own store throttle (one write a second, the last
    // scroll kept): leaving sooner would ask the book to remember a place it has not written yet,
    // which is a different question than «does a back return where I was».
    await cdp.evaluate(page.settle({ budgetMs: 2000, stableFrames: 3, minMs: 250 }));
    await sleep(1_200);
    const before = await cdp.evaluate(page.locate(placed.prefix, chapter));
    await cdp.evaluate(page.install());
    // A link the page itself holds is the reader's way out (the foot's `#discussion`, a contents
    // row's `#ch-N`); only when the page has none does the harness write the hash, and the record
    // says which it did — a scripted hash does not pass through the product's capture.
    const via = await cdp.evaluate(page.tapLink(item.hash));
    if (via.tapped !== true) await cdp.evaluate(page.hash(item.hash));
    log(`  away ${item.hash} via=${via.tapped === true ? 'link' : 'hash'}`);
    await cdp.evaluate(page.settle({ budgetMs: 3000, stableFrames: 3, minMs: 300 }));
    await cdp.evaluate(page.back());
    await sleep(300);
    await cdp.evaluate(page.install());
    await cdp.evaluate(page.settle({ budgetMs: 3000, stableFrames: 3, minMs: 600 }));
    const after = await cdp.evaluate(page.locate(placed.prefix, chapter));
    const delta = after.found === true && before.found === true ? round2(after.after - before.after) : null;
    const item_ = {
      width: viewport.width,
      case: item.name,
      via: via.tapped === true ? 'link' : 'hash',
      sentence: placed.prefix,
      before: before.found === true ? before.after : null,
      after: after.found === true ? after.after : null,
      delta,
      found: after.found === true,
    };
    measured.push(item_);
    process.stdout.write(
      `back case=${item_.case} sentence=${item_.sentence} before=${String(item_.before)} ` +
        `after=${String(item_.after)} delta=${String(item_.delta)} found=${item_.found === true ? 'yes' : 'no'}\n`,
    );
  }
  return measured;
}

/**
 * The product's row for **this** chapter, once it has stopped moving. The page writes a place on
 * every scroll (at most once a second, with the last scroll kept), so the first row after a jump
 * may still name the place the harness came from: the row is accepted only when it names the
 * chapter under the reader and has held the same sentence for ~0.7 s. `null` means no place
 * layer at all — the device keeps nothing, and there is nothing to assert.
 */
async function capturedPlace(cdp, chapter, budgetMs = 6_000) {
  const started = Date.now();
  let held = null;
  let since = 0;
  let last = null;
  for (;;) {
    const row = await cdp.evaluate(page.placeRow());
    const value = row === null ? null : row.value;
    if (value !== null && value.chapter === chapter) {
      const key = `${String(value.sentenceId)}|${String(value.deltaPx)}`;
      if (held === key) {
        if (Date.now() - since >= 700) return row;
      } else {
        held = key;
        since = Date.now();
      }
      last = row;
    }
    if (Date.now() - started > budgetMs) return row !== null ? row : last;
    await sleep(120);
  }
}

/**
 * Wait for the page's own landing to finish: an anchor is «restored» when the element it names
 * is on the page *and holds still* — the product's landing is one jump plus a bounded
 * correction, so two equal samples mean the number is the one a reader would see.
 */
async function waitForAnchor(cdp, sentenceId, budgetMs = 8_000) {
  const started = Date.now();
  let last = null;
  let still = 0;
  let answer = { found: false, after: null, text: null };
  for (;;) {
    answer = await cdp.evaluate(page.locateById(sentenceId));
    if (answer.found === true && Number.isFinite(answer.after)) {
      still = last !== null && Math.abs(answer.after - last) < 0.5 ? still + 1 : 0;
      last = answer.after;
      if (still >= 2) return answer;
    }
    if (Date.now() - started > budgetMs) return answer;
    await sleep(120);
  }
}

/**
 * AC3 (i): one device, one reload. The anchor is **the product's own row** — read out of its
 * store after the reader's scroll, never built here — and `restored` is null when the device
 * keeps no place at all: a device that was never measured is not a miss.
 *
 * Nothing sets `history.scrollRestoration` here: the page's own answer to a reload is the anchor
 * (its position layer sets `manual` itself), and a harness that ordered it would be measuring
 * its own line of code.
 */
export async function measureSameDevice(cdp, viewport, chapter, index, log) {
  await openPage(cdp, viewport, { fresh: true });
  await cdp.evaluate(page.install());
  const placed = await cdp.evaluate(page.place(chapter, index));
  if (placed.found !== true) {
    log(`place: no sentence ${String(index)} in #ch-${String(chapter)} (${String(placed.count)} loaded)`);
    return null;
  }
  const row = await capturedPlace(cdp, chapter);
  const anchor = row === null || row.value === null ? null : row.value;
  if (anchor !== null && anchor.chapter !== chapter) {
    log(`place: the device kept chapter ${String(anchor.chapter)}, not ${String(chapter)} — measured as it is`);
  }
  const before = anchor === null ? { found: false, after: null } : await waitForAnchor(cdp, anchor.sentenceId, 2_000);
  const line = await cdp.evaluate(page.readingLine());
  await sleep(1_200);
  await cdp.send('Page.reload');
  await waitForApp(cdp);
  const top = await cdp.evaluate('Math.round(window.scrollY)');
  const afterLine = await cdp.evaluate(page.readingLine());
  const after = anchor === null ? { found: false, after: null } : await waitForAnchor(cdp, anchor.sentenceId);
  // A row this device kept is a measurement, even when the anchor it names cannot be found:
  // silence would hide a place that points nowhere.
  const measured = anchor !== null;
  const restored =
    measured &&
    before.found === true &&
    after.found === true &&
    Number.isFinite(after.after) &&
    Number.isFinite(before.after) &&
    Math.abs(after.after - before.after) <= POSITION_TOLERANCE_PX;
  return {
    measured,
    top,
    sentence: afterLine === null ? null : afterLine.text,
    anchor,
    before: before.found === true ? before.after : null,
    after: after.found === true ? after.after : null,
    restored: measured ? restored : null,
    key: row === null ? null : row.key,
    readAt: line === null ? null : line.text,
  };
}

/** One `PUT` of the product's own row, with the seeded session: what a signed-in device sends. */
export async function putPlace(session, place, log) {
  try {
    const answer = await fetchRetry(
      `${boot.POSITION_ORIGIN}/api/me/place`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: `${session.name}=${session.value}` },
        body: JSON.stringify({
          chapter: place.chapter,
          sentenceId: place.sentenceId,
          deltaPx: place.deltaPx,
          at: place.at,
        }),
      },
      log,
    );
    return answer.status;
  } catch {
    return 0;
  }
}

/**
 * AC3 (ii): the same origin, another browser context, **only** the session cookie — a second
 * device. It has no `localStorage`, so the only place it can resume is the server's row; the
 * assertion is the same sentence at the same offset as the first device (±2 px).
 */
export async function measureSecondDevice(browser, viewport, session, anchor, log) {
  const browserCdp = await Cdp.open(browser.browserWs);
  let cdp = null;
  try {
    const { browserContextId } = await browserCdp.send('Target.createBrowserContext', { disposeOnDetach: false });
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const targets = await (await fetch(`http://127.0.0.1:${String(browser.port)}/json/list`)).json();
    const target = targets.find((item) => item.id === targetId);
    if (target === undefined) throw harnessError('the second context opened no page target');
    cdp = await Cdp.open(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: session.name,
      value: session.value,
      url: `${boot.POSITION_ORIGIN}/`,
      path: '/',
      httpOnly: true,
    });
    await openPage(cdp, viewport);
    const after = await waitForAnchor(cdp, anchor.sentenceId);
    const top = await cdp.evaluate('Math.round(window.scrollY)');
    const line = await cdp.evaluate(page.readingLine());
    const restored =
      after.found === true && Number.isFinite(after.after) && Math.abs(after.after - anchor.before) <= POSITION_TOLERANCE_PX;
    return {
      measured: true,
      top,
      sentence: line === null ? null : line.text,
      anchor,
      before: anchor.before,
      after: after.found === true ? after.after : null,
      restored,
      // Read after the resume: the page's own capture has already stored its place here, so
      // this is not the device's starting storage — the context started empty.
      storageAfterResume: await cdp.evaluate('window.localStorage.length'),
    };
  } finally {
    if (cdp !== null) cdp.close();
    browserCdp.close();
  }
}

/**
 * What the server says about its place route, asked twice: without a cookie and with the seeded
 * session. The three answers are the three facts — `404` is a route that does not exist,
 * `401` is the guarded `/api/me` prefix (the route answers only its reader), `200`/`204` is a
 * route that answered. A route that refuses *this* session is reported as guarded, never as
 * «not implemented»: the harness says what it saw, not what it hoped.
 */
export async function probeResumeServer(session, log) {
  const url = `${boot.POSITION_ORIGIN}/api/me/place`;
  const ask = async (headers) => {
    try {
      const answer = await fetchRetry(url, { headers, redirect: 'manual' }, log);
      return answer.status;
    } catch {
      return 0;
    }
  };
  const anonymous = await ask({});
  const signed = session === null ? 0 : await ask({ cookie: `${session.name}=${session.value}` });
  const answered = anonymous === 200 || anonymous === 204 || signed === 200 || signed === 204;
  const absent = !answered && (anonymous === 404 || signed === 404);
  const outcome = answered ? 'answered' : absent ? 'absent' : 'guarded';
  return { outcome, anonymous, signed };
}

