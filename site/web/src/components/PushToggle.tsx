import type { ViewerDto } from '@book/shared';
import { useEffect, useState } from 'react';

import {
  browserPushEnv,
  pushSupport,
  readDeviceState,
  readKey,
  subscribe,
  unsubscribe,
  type PushEnvironment,
} from '../lib/push.ts';

/** The denial the browser itself holds: a tap cannot undo it, so the row states it and stops. */
export const PUSH_DENIED_LINE = 'уведомления: выключены в браузере';

/** iOS takes push only from the installed app — the row says so instead of failing silently. */
export const PUSH_IOS_LINE = 'уведомления — только из установленного приложения';

/** One failed attempt: the state is unchanged, and the reader may try again. */
export const PUSH_FAILED_LINE = 'не удалось — попробуйте ещё';

/**
 * BOOK-189 — whether this reader hears about their own filings, as a row of the colophon.
 *
 * The row exists only where the answer can be true: a signed-out reader has no filings to hear
 * about, a browser without `serviceWorker`/`PushManager`/`Notification` cannot receive anything,
 * and a deployment that answers `/api/push/key` with 503 has push switched off — printing
 * «включить» over any of those would promise what cannot work. The key is read once per mount and
 * every failure is swallowed: with no key the row is simply absent.
 *
 * Nothing is asked on mount. `requestPermission()` is reached only by the click (see `lib/push.ts`
 * for why), so a reader who never touches this row is never prompted and the browser's own
 * permission question is spent on the one act that wanted it.
 *
 * Two states have no button: a permission the browser has already refused (the page cannot grant
 * it back) and iOS without the app installed (the browser cannot subscribe from a tab).
 *
 * `fetcher` and `env` are the test seams: jsdom has no push objects and no permission prompt, and
 * a unit test drives both by hand.
 */
export function PushToggle({
  viewer,
  fetcher = fetch,
  env,
}: {
  viewer: ViewerDto;
  fetcher?: typeof fetch;
  env?: PushEnvironment;
}) {
  // One environment, and one transport, for the life of the row: a fresh `browserPushEnv()` on
  // every render would be a new object on every state change, and every read would re-run.
  const [wiring] = useState(() => ({ env: env ?? browserPushEnv(), fetcher }));
  const support = pushSupport(wiring.env);
  const [key, setKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState<'on' | 'off'>('off');
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const signedIn = viewer.signedIn;
  useEffect(() => {
    // No reader to hear about, no browser to hear with: the page asks the site nothing.
    if (!signedIn || support === 'unsupported') return undefined;
    // `alive`, not `live`: the effect's own flag must not read as a gated prop defaulted on
    // (server/test/historySelector.test.ts scans the components for exactly that).
    let alive = true;
    void (async () => {
      const found = await readKey(wiring.fetcher);
      if (!alive) return;
      setKey(found);
      // A state the browser holds is a read, not a request: the prompt is never opened here.
      setDenied(wiring.env.notification?.permission === 'denied');
      if (found !== null) {
        const state = await readDeviceState(wiring.env);
        if (!alive) return;
        setDevice(state);
      }
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [signedIn, support, wiring]);

  if (!signedIn) return null;
  if (support === 'unsupported') return null;
  if (!ready || key === null) return null;

  const row = (line: string) => (
    <div className="row">
      <span className="push-row">{line}</span>
    </div>
  );
  if (support === 'ios-not-installed') return row(PUSH_IOS_LINE);
  if (denied) return row(PUSH_DENIED_LINE);

  const on = device === 'on';
  const tap = (): void => {
    // One request at a time: a second tap while the first is in flight would race the same key.
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const answer: Promise<'ok' | 'denied' | 'failed'> = on
      ? unsubscribe(wiring.env, wiring.fetcher)
      : subscribe(wiring.env, key, wiring.fetcher);
    // Both calls are total: each answers `ok`/`denied`/`failed` and never rejects.
    void answer.then((result) => {
      setBusy(false);
      if (result === 'ok') setDevice(on ? 'off' : 'on');
      else if (result === 'denied') setDenied(true);
      else setFailed(true);
    });
  };

  return (
    <div className="row">
      <span className="push-row">
        {`уведомления: ${on ? 'включены' : 'выключены'} · `}
        <button type="button" className="push-toggle" onClick={tap} disabled={busy}>
          {on ? 'выключить' : 'включить'}
        </button>
        {failed ? <span className="push-error"> · {PUSH_FAILED_LINE}</span> : null}
      </span>
    </div>
  );
}
