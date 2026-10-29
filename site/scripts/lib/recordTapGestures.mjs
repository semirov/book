/**
 * lib/recordTapGestures.mjs — the input a browser really sends, and the page helpers the tap
 * matrix reads. Split from `scripts/record-tap.mjs` to stay under the 500-line file limit.
 */

export const HEIGHT = 780;

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function touch(cdp, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }],
  });
}

async function mouse(cdp, type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
}

/** One tap: down, up, and the click the engine synthesizes from it. */
export async function tap(cdp, mobile, point) {
  if (mobile) {
    await touch(cdp, 'touchStart', point.x, point.y);
    await touch(cdp, 'touchEnd');
    return;
  }
  await mouse(cdp, 'mouseMoved', point.x, point.y, { button: 'none' });
  await mouse(cdp, 'mousePressed', point.x, point.y);
  await mouse(cdp, 'mouseReleased', point.x, point.y);
}

/** A tap whose finger wobbles `dx` px: still a tap inside the 12 px slop. */
export async function dragTap(cdp, mobile, point, dx, dy) {
  if (mobile) {
    await touch(cdp, 'touchStart', point.x, point.y);
    await touch(cdp, 'touchMove', point.x + dx, point.y + dy);
    await sleep(16);
    await touch(cdp, 'touchEnd');
    return;
  }
  await mouse(cdp, 'mouseMoved', point.x, point.y, { button: 'none' });
  await mouse(cdp, 'mousePressed', point.x, point.y);
  await mouse(cdp, 'mouseMoved', point.x + dx, point.y + dy, { button: 'left' });
  await mouse(cdp, 'mouseReleased', point.x + dx, point.y + dy);
}

/** Load the harness fresh: the record store is page state, so every case starts empty. */
export async function open(cdp, origin, page, width, query = '') {
  const mobile = width < 600;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 1 });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await cdp.send('Page.navigate', { url: `${origin}${page}${query === '' ? '' : `?${query}`}` });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await cdp.evaluate('window.__recordTap?.ready?.() === true').catch(() => false);
    if (ready === true) break;
    await sleep(50);
  }
  await cdp.evaluate('document.fonts.ready.then(() => true)');
  await sleep(80);
  return mobile;
}

export const scan = (cdp, point) =>
  cdp.evaluate(`window.__recordTap.scan(${point === undefined ? 'undefined' : JSON.stringify(point)})`);

export const pointOn = (cdp, index, fraction) =>
  cdp.evaluate(`window.__recordTap.pointOnSentence(${String(index)}${fraction === undefined ? '' : `, ${String(fraction)}`})`);

/** A point on a control that is actually on screen: scrolled into view first. */
export async function pointOf(cdp, selector) {
  await cdp.evaluate(`window.__recordTap.scrollInto(${JSON.stringify(selector)})`);
  await sleep(80);
  return cdp.evaluate(`window.__recordTap.pointOf(${JSON.stringify(selector)})`);
}

/** Tap a control by selector; `null` when the control is not on the page (a failed step). */
export async function press(cdp, mobile, selector) {
  const exists = await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  if (exists !== true) return null;
  const point = await pointOf(cdp, selector);
  await tap(cdp, mobile, point);
  return point;
}
