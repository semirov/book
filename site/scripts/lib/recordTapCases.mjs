/**
 * lib/recordTapCases.mjs — the record's tap matrix (a–g, 1–6, h), one case per function.
 *
 * Split from `scripts/record-tap.mjs` to stay under the 500-line file limit; the gestures and
 * the page helpers are `recordTapGestures.mjs`.
 */

import { HEIGHT, dragTap, open, pointOf, pointOn, press, scan, sleep, tap } from './recordTapGestures.mjs';

/**
 * Every case returns `{ pass, detail }`. A case that throws is a failed case, not a crashed
 * run: the matrix is the report, and one broken step must not hide the others.
 */
async function caseOf(cdp, origin, page, width, name, body, log) {
  try {
    const result = await body();
    log(`${String(width)} ${name}:`, JSON.stringify(result));
    return { name, pass: result.pass, detail: result.detail };
  } catch (error) {
    log(`${String(width)} ${name} threw:`, String(error));
    return { name, pass: false, detail: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function matrix(cdp, origin, page, width, log) {
  const cases = [];
  const run = (name, body) => caseOf(cdp, origin, page, width, name, body, log);

  cases.push(
    await run('a', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 0));
      await sleep(420);
      const opened = await scan(cdp);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      const after = await scan(cdp);
      const mounts = await cdp.evaluate('window.__recordTap.mounts()');
      return {
        pass:
          opened.rec === 1 && opened.acc === 'open' && mounts.added === 1 && mounts.removed === 0 &&
          after.form === true && after.body === 'form' && after.firstFieldFocused === true,
        detail: { opened, after, mounts },
      };
    }),
  );

  cases.push(
    await run('b', async () => {
      await open(cdp, origin, page, width, 'rows=1');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      const opened = await scan(cdp);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      const notice = await scan(cdp);
      const line = await cdp.evaluate("window.__recordTap.text('.rec-notice-line')");
      const openExisting = await cdp.evaluate("window.__recordTap.count('.rec-notice-open')");
      await press(cdp, mobile, '.rec-notice-new');
      await sleep(200);
      const form = await scan(cdp);
      return {
        pass:
          opened.rec === 1 && notice.body === 'notice' && line === 'у этой фразы уже есть заявка — открыть её?' &&
          openExisting === 1 && form.form === true && form.firstFieldFocused === true,
        detail: { opened, notice, line, openExisting, form },
      };
    }),
  );

  cases.push(
    await run('c', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      const point = await pointOn(cdp, 1);
      await tap(cdp, mobile, point);
      await sleep(120);
      const first = await scan(cdp);
      await tap(cdp, mobile, point);
      await sleep(320);
      const second = await scan(cdp);
      const mounts = await cdp.evaluate('window.__recordTap.mounts()');
      return {
        pass:
          first.rec === 1 && first.acc === 'open' && second.rec === 0 &&
          mounts.added === 1 && mounts.removed === 1 && second.scale === 1 && second.touchAction === 'manipulation',
        detail: { first, second, mounts },
      };
    }),
  );

  cases.push(
    await run('d', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 0));
      await sleep(280);
      const a = await scan(cdp);
      await tap(cdp, mobile, await pointOn(cdp, 2));
      await sleep(280);
      const b = await scan(cdp);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      const after = await scan(cdp);
      const quote = await cdp.evaluate("window.__recordTap.text('.rec-quote')");
      return {
        pass: a.rec === 1 && b.rec === 1 && b.acc === 'open' && after.form === true && after.firstFieldFocused === true,
        detail: { a, b, after, quote },
      };
    }),
  );

  cases.push(
    await run('e', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      await cdp.evaluate("window.__recordTap.typeInto('textarea.seam-text', 'Черновик под отправкой.')");
      await press(cdp, mobile, '.seam-submit');
      await sleep(160);
      const sending = await scan(cdp);
      // While the request is in flight the form is intact, and the ✕ still closes the block;
      // the sentence reopens it, and `вмешаться` is one act again with the draft kept.
      await press(cdp, mobile, '.rec-close');
      await sleep(240);
      const closed = await scan(cdp);
      await cdp.evaluate('window.__recordTap.sentenceInto(1)');
      await sleep(120);
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(320);
      const reopened = await scan(cdp);
      await press(cdp, mobile, '.rec-cta');
      await sleep(200);
      const formAgain = await scan(cdp);
      await sleep(1600);
      const settled = await scan(cdp);
      return {
        pass:
          sending.form === true && sending.submit === 'передаётся' && sending.draft === 'Черновик под отправкой.' &&
          closed.rec === 0 && reopened.rec === 1 && formAgain.form === true &&
          formAgain.draft === 'Черновик под отправкой.' && formAgain.submit === 'передать' &&
          settled.rec === 1 && settled.form === true && settled.draft === 'Черновик под отправкой.',
        detail: { sending, closed, reopened, formAgain, settled },
      };
    }),
  );

  cases.push(
    await run('f', async () => {
      const mobile = width < 600;
      await open(cdp, origin, page, width, 'rows=0');
      await tap(cdp, mobile, await pointOn(cdp, 0));
      await sleep(420);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      const signedIn = await scan(cdp);
      await open(cdp, origin, page, width, 'rows=0&out=1');
      await tap(cdp, mobile, await pointOn(cdp, 0));
      await sleep(420);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      const signedOut = await scan(cdp);
      return {
        pass:
          signedIn.form === true && signedIn.firstFieldFocused === true &&
          signedOut.form === false && signedOut.signin !== null && signedOut.signin.includes('войдите через Яндекс'),
        detail: { signedIn, signedOut },
      };
    }),
  );

  cases.push(
    await run('g', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      await cdp.evaluate('window.__recordTap.recordTopAt(-30)');
      await sleep(120);
      const shifted = await scan(cdp);
      const cta = await cdp.evaluate("window.__recordTap.pointOf('.rec-cta')");
      const visible = cta.y > 0 && cta.y < HEIGHT;
      await tap(cdp, mobile, cta);
      await sleep(160);
      const after = await scan(cdp);
      return {
        pass: shifted.recordTop < 0 && visible && after.form === true && after.firstFieldFocused === true,
        detail: { shifted, cta, after },
      };
    }),
  );

  cases.push(
    await run('1', async () => {
      await open(cdp, origin, page, width, 'rows=1');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      const opened = await scan(cdp);
      const mounts = await cdp.evaluate('window.__recordTap.mounts()');
      return {
        pass: opened.rec === 1 && opened.acc === 'open' && mounts.added === 1 && mounts.removed === 0,
        detail: { opened, mounts },
      };
    }),
  );

  cases.push(
    await run('2', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      const opened = await scan(cdp);
      // BOOK-220 §11.3 — an untouched sentence is not a list: the block names itself in its own
      // label («запись о фразе»), no hand stands above it, and no `замечания` label stands above
      // a filing the sentence does not hold.
      const head = await cdp.evaluate(
        "document.querySelector('.rec')?.getAttribute('aria-label')?.split(' · ')[0] ?? null",
      );
      const hand = await cdp.evaluate("window.__recordTap.text('.rec-hand')");
      const labels = await cdp.evaluate(
        "Array.from(document.querySelectorAll('.rec-section-label')).map((node) => node.textContent)",
      );
      return {
        pass:
          opened.rec === 1 && opened.acc === 'open' &&
          head === 'запись о фразе' &&
          // §11.3 — with no filing on the sentence the printer's act is the point, and it is
          // the only line the head carries; `история` stays the section that names it in rows.
          (hand === null || /^машина /u.test(hand)) &&
          !labels.includes('замечания'),
        detail: { opened, head, hand, labels },
      };
    }),
  );

  cases.push(
    await run('3', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      // The wobble is a finger's: at 1440 a mouse drag of 10 px selects text, and a selection
      // is the reader copying (it wins by design) — so both widths take a touch pointer here.
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const point = await pointOn(cdp, 1);
      await dragTap(cdp, true, point, 10, 0);
      await sleep(420);
      const small = await scan(cdp);
      await open(cdp, origin, page, width, 'rows=0');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const point2 = await pointOn(cdp, 1);
      await dragTap(cdp, true, point2, 0, 60);
      await sleep(420);
      const long = await scan(cdp);
      return {
        pass: small.rec === 1 && small.acc === 'open' && long.rec === 0,
        detail: { small, long },
      };
    }),
  );

  cases.push(
    await run('4', async () => {
      await open(cdp, origin, page, width, 'rows=0');
      const mobile = width < 600;
      const point = await pointOn(cdp, 1);
      await tap(cdp, mobile, point);
      await sleep(120);
      await tap(cdp, mobile, point);
      await sleep(300);
      const after = await scan(cdp);
      const meta = await cdp.evaluate("document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null");
      log('viewport:', String(meta));
      return {
        pass:
          after.rec === 0 && after.scale === 1 && after.touchAction === 'manipulation' &&
          typeof meta === 'string' && !/maximum-scale|user-scalable\s*=\s*no/u.test(meta),
        detail: { after, meta },
      };
    }),
  );

  cases.push(
    await run('5', async () => {
      await open(cdp, origin, page, width, 'rows=1');
      const mobile = width < 600;
      const sentences = await cdp.evaluate('window.__recordTap.sentences()');
      await cdp.evaluate('window.__recordTap.sentenceAtBottom(1, 4)');
      await sleep(120);
      const point = await pointOn(cdp, 1);
      const hit = await scan(cdp, point);
      await tap(cdp, mobile, point);
      await sleep(420);
      const opened = await scan(cdp);
      // The grip's own band keeps its own act: a tap there is not prose.
      const bandPoint = { x: Math.round(width / 2), y: HEIGHT - 8 };
      const band = await scan(cdp, bandPoint);
      await tap(cdp, mobile, bandPoint);
      await sleep(120);
      const afterBand = await scan(cdp);
      return {
        pass:
          hit.grip > 0 && hit.at === String(sentences[1].start) && opened.rec === 1 &&
          band.at === 'grip' && afterBand.rec === opened.rec,
        detail: { hit, opened, band, afterBand },
      };
    }),
  );

  cases.push(
    await run('6', async () => {
      await open(cdp, origin, page, width, 'rows=1');
      const mobile = width < 600;
      const sentences = await cdp.evaluate('window.__recordTap.sentences()');
      const failures = [];
      const seen = [];
      for (let index = 0; index < sentences.length; index += 1) {
        if (index > 0) await cdp.evaluate('window.__recordTap.scrollTop()');
        const point = await pointOn(cdp, index);
        await tap(cdp, mobile, point);
        await sleep(320);
        const opened = await scan(cdp);
        seen.push({ index, rec: opened.rec, acc: opened.acc });
        if (opened.rec !== 1 || opened.acc !== 'open') failures.push({ index, opened });
        // Close through the ✕: the next sentence starts from no block, not from a toggle.
        const close = await cdp.evaluate("window.__recordTap.pointOf('.rec-close')").catch(() => null);
        if (close !== null && close.y > 0 && close.y < HEIGHT) {
          await tap(cdp, mobile, close);
          await sleep(220);
        } else {
          await open(cdp, origin, page, width, 'rows=1');
        }
      }
      return { pass: sentences.length > 2 && failures.length === 0, detail: { count: sentences.length, seen, failures } };
    }),
  );

  cases.push(
    await run('h', async () => {
      const mobile = width < 600;
      /** The measured control's own top, around one inner toggle. */
      const toggle = async (measure, pressSelector) => {
        const exists = await cdp.evaluate(`document.querySelector(${JSON.stringify(pressSelector)}) !== null`);
        if (exists !== true) return { before: null, after: null, delta: null, missing: pressSelector };
        const point = await pointOf(cdp, pressSelector);
        const before = await cdp.evaluate(`window.__recordTap.${measure}`);
        await tap(cdp, mobile, point);
        await sleep(200);
        const after = await cdp.evaluate(`window.__recordTap.${measure}`);
        const delta = before === null || after === null ? null : Math.round((after - before) * 100) / 100;
        return { before, after, delta };
      };
      // The sections: opening `история` closes `замечания` above it, so the pressed header is
      // the control that would otherwise run out from under the finger.
      await open(cdp, origin, page, width, 'rows=2');
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      const history = await toggle("topOfText('история')", '.rec-section:nth-of-type(2)');
      const sections = await toggle("topOfText('замечания')", '.rec-section:nth-of-type(1)');
      // The form and the note: `без правки` takes the kind grid and the field away above the
      // pressed action; the compensation keeps that action where the thumb left it.
      await open(cdp, origin, page, width, 'rows=0');
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      await press(cdp, mobile, '.rec-cta');
      await sleep(220);
      const note = await toggle("topOf('.note-action')", '.note-action');
      const noteBack = await toggle("topOf('.note-action')", '.note-action');
      // The notice → form swap, on a sentence that already carries a filing: the pressed button
      // is replaced, so the head row — the row the reader's eye is on — is what must hold.
      await open(cdp, origin, page, width, 'rows=1');
      await tap(cdp, mobile, await pointOn(cdp, 1));
      await sleep(420);
      await press(cdp, mobile, '.rec-cta');
      await sleep(160);
      const notice = await toggle("topOf('.rec-head')", '.rec-notice-new');
      const held = [history, sections, note, noteBack, notice].every(
        (entry) => entry.delta !== null && Math.abs(entry.delta) <= 1,
      );
      return { pass: held, detail: { history, sections, note, noteBack, notice } };
    }),
  );

  return cases;
}
