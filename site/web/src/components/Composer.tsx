import type { CatalogEntry, CommentBudget, ComposerInfo, ViewerDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { ApiError, logoutSession, postComment } from '../api.ts';
import { composerView, validateDraft, type ComposerError } from '../lib/composer.ts';

/**
 * The composer (§12.1, §12.8, §11.6).
 *
 * Two rules decide its shape: the CAPTCHA widget is mounted **lazily**, when a signed-in
 * reader is about to write (the reading path stays third-party-free), and the composer
 * **closes** rather than opens when verification is unavailable. The provider's script is
 * loaded here and nowhere else.
 */

type CaptchaApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string | number;
  reset?: (widgetId: string | number) => void;
  remove?: (widgetId: string | number) => void;
};

const SCRIPT_URLS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
} as const;

const scriptPromises = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const cached = scriptPromises.get(src);
  if (cached !== undefined) return cached;
  const promise = new Promise<void>((resolve, reject) => {
    const element = document.createElement('script');
    element.src = src;
    element.async = true;
    element.defer = true;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error('captcha script failed'));
    document.head.appendChild(element);
  });
  scriptPromises.set(src, promise);
  return promise;
}

function captchaApi(provider: 'turnstile' | 'hcaptcha'): CaptchaApi | null {
  const scope = window as unknown as { turnstile?: CaptchaApi; hcaptcha?: CaptchaApi };
  return provider === 'turnstile' ? (scope.turnstile ?? null) : (scope.hcaptcha ?? null);
}

export function Composer({
  viewer,
  composer,
  chapters,
  onPosted,
}: {
  viewer: ViewerDto;
  composer: ComposerInfo;
  chapters: readonly CatalogEntry[];
  onPosted: () => void;
}) {
  const written = chapters.filter((entry) => entry.written);
  const [chapter, setChapter] = useState<number>(written[written.length - 1]?.n ?? 1);
  const [body, setBody] = useState('');
  const [proposed, setProposed] = useState('');
  const [showProposed, setShowProposed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<ComposerError | null>(null);
  const [sent, setSent] = useState(false);
  const [budget, setBudget] = useState<CommentBudget | null>(null);
  const [sending, setSending] = useState(false);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | number | null>(null);

  const view = composerView({ viewer, composer, error, sent, budget });
  const provider = composer.captcha.provider;
  // A refused-but-retryable comment (a failed token, a stale anchor) keeps the widget armed.
  const interactive = view.kind === 'ready' || (view.kind === 'refused' && view.canRetry);

  useEffect(() => {
    if (!interactive || provider === 'none' || composer.captcha.siteKey === null) return;
    let cancelled = false;
    void loadScript(SCRIPT_URLS[provider])
      .then(() => {
        if (cancelled || widgetRef.current === null) return;
        const api = captchaApi(provider);
        if (api === null) {
          setError({ code: 'CAPTCHA_UNAVAILABLE', message: '' });
          return;
        }
        widgetId.current = api.render(widgetRef.current, {
          sitekey: composer.captcha.siteKey,
          theme: 'light',
          callback: (value: string) => {
            setToken(value);
            setError((current) => (current?.code === 'CAPTCHA_FAILED' ? null : current));
          },
          'expired-callback': () => setToken(null),
          'error-callback': () => setError({ code: 'CAPTCHA_UNAVAILABLE', message: '' }),
        });
      })
      .catch(() => {
        if (!cancelled) setError({ code: 'CAPTCHA_UNAVAILABLE', message: '' });
      });
    return () => {
      cancelled = true;
      const api = captchaApi(provider);
      if (widgetId.current !== null) api?.remove?.(widgetId.current);
      widgetId.current = null;
    };
  }, [interactive, provider, composer.captcha.siteKey]);

  const submit = async (): Promise<void> => {
    const draft = validateDraft({ body, proposed: showProposed ? proposed : '', composer, captchaToken: token });
    if (!draft.ok) {
      setError({ code: 'INVALID', message: draft.line });
      return;
    }
    setSending(true);
    try {
      const response = await postComment({
        chapter,
        body: draft.body,
        captchaToken: token ?? '',
        ...(draft.proposed === null ? {} : { proposedText: draft.proposed }),
      });
      setBody('');
      setProposed('');
      setShowProposed(false);
      setToken(null);
      setError(null);
      setSent(true);
      setBudget(response.remaining);
      if (widgetId.current !== null) {
        const api = provider === 'none' ? null : captchaApi(provider);
        api?.reset?.(widgetId.current);
      }
      onPosted();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError({
          code: caught.code,
          message: caught.message,
          ...(caught.retryAfterMs === undefined ? {} : { retryAfterMs: caught.retryAfterMs }),
          ...(caught.resetAt === undefined ? {} : { resetAt: caught.resetAt }),
        });
        if (caught.code === 'CAPTCHA_FAILED') {
          setToken(null);
          const api = provider === 'none' ? null : captchaApi(provider);
          if (widgetId.current !== null) api?.reset?.(widgetId.current);
        }
      } else {
        setError({ code: 'INVALID', message: 'сеть не ответила — попробуйте ещё раз' });
      }
    } finally {
      setSending(false);
    }
  };

  if (view.kind === 'signin') {
    return (
      <div className="composer composer-note" data-state="signin">
        <p>{view.line}</p>
        <a className="composer-link" href="/auth/yandex/start">
          войти через Яндекс →
        </a>
        <p className="fine">
          Читать можно без входа. Автор замечания виден другим читателям.{' '}
          <a className="composer-link" href="/privacy">что видят другие →</a>
        </p>
      </div>
    );
  }

  if (view.kind === 'closed') {
    return (
      <div className="composer composer-note" data-state="closed" role="status">
        <p>{view.line}</p>
        <p className="fine">{view.detail}</p>
      </div>
    );
  }

  if (written.length === 0) {
    return (
      <div className="composer composer-note" data-state="empty">
        <p>Замечания откроются вместе с первой главой.</p>
      </div>
    );
  }

  return (
    <div className="composer" data-state={view.kind}>
      <div className="composer-row">
        <label className="composer-label" htmlFor="composer-chapter">
          глава
        </label>
        <select
          id="composer-chapter"
          value={chapter}
          onChange={(event) => setChapter(Number(event.target.value))}
          disabled={sending}
        >
          {written.map((entry) => (
            <option key={entry.n} value={entry.n}>
              {entry.title === null ? `${entry.n}.` : `${entry.n}. ${entry.title}`}
            </option>
          ))}
        </select>
        <span className="composer-who">{viewer.displayName ?? 'читатель'}</span>
        <button
          className="composer-link"
          type="button"
          onClick={() => {
            void logoutSession().finally(() => window.location.reload());
          }}
        >
          выйти
        </button>
      </div>

      <label className="composer-label" htmlFor="composer-body">
        замечание к тексту
      </label>
      <textarea
        id="composer-body"
        value={body}
        maxLength={composer.maxChars}
        rows={4}
        placeholder="что в абзаце не читается: повтор, сбой, деталь, которой не веришь"
        onChange={(event) => {
          setBody(event.target.value);
          setSent(false);
        }}
        disabled={sending}
      />
      <div className="composer-count">
        {body.length} / {composer.maxChars}
      </div>

      <label className="composer-check">
        <input
          type="checkbox"
          checked={showProposed}
          onChange={(event) => setShowProposed(event.target.checked)}
          disabled={sending}
        />
        предложить свой вариант — одна правка в сутки
      </label>
      {showProposed ? (
        <>
          <label className="composer-label" htmlFor="composer-proposed">
            свой вариант абзаца
          </label>
          <textarea
            id="composer-proposed"
            value={proposed}
            maxLength={composer.maxChars}
            rows={3}
            onChange={(event) => setProposed(event.target.value)}
            disabled={sending}
          />
        </>
      ) : null}

      <div className="composer-captcha" ref={widgetRef} />
      {view.kind === 'refused' ? (
        <p className="composer-error" role="alert">
          {view.line}
          {view.detail === null ? null : <span className="composer-detail"> · {view.detail}</span>}
        </p>
      ) : null}
      {view.kind === 'sent' ? (
        <p className="composer-sent" role="status">
          {view.line}
          {view.detail === null ? null : <span className="composer-detail"> · {view.detail}</span>}
        </p>
      ) : null}
      {view.kind === 'ready' && view.detail !== null ? <p className="fine">{view.detail}</p> : null}

      <div className="composer-actions">
        <button type="button" onClick={() => void submit()} disabled={sending || token === null}>
          {sending ? 'отправляется' : 'оставить замечание'}
        </button>
        <span className="fine">
          Читают как данные, не как указания. <a className="composer-link" href="/privacy">что видят другие →</a>
        </span>
      </div>
    </div>
  );
}
