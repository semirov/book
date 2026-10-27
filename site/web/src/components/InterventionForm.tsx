import type { CatalogEntry, ComposerInfo, ViewerDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { ApiError, postAnchoredComment } from '../api.ts';
import { captchaApi, loadCaptchaScript } from '../lib/captcha.ts';
import { budgetLine, counterLabel, draftLimits, errorCopy, type ComposerError } from '../lib/composer.ts';
import { anchoredPayload, submissionBody, submitLabel, wordingLabel, type SeamDraft } from '../lib/draft.ts';
import { InterventionKinds } from './InterventionKinds.tsx';

/**
 * BOOK-DOC-34 §2.3 — the form, grown inside the seam.
 *
 * Field order is the book's own logic: what the world-fact is → what it changes → how it
 * reads. The CAPTCHA is a field (the script mounts on the first textarea focus, never on page
 * load), errors are printed in place — never a toast — and the receipt is the caller's: a
 * refused draft keeps every character, and a stale anchor offers the re-anchoring path
 * instead of silently moving the filing.
 */
export type FormProps = {
  entry: CatalogEntry;
  draft: SeamDraft;
  composer: ComposerInfo;
  viewer: ViewerDto;
  onChange: (draft: SeamDraft) => void;
  onPosted: (number: string) => void;
  onReanchor?: (draft: SeamDraft) => void;
};

export function InterventionForm({ entry, draft, composer, viewer, onChange, onPosted, onReanchor }: FormProps) {
  const limits = draftLimits(composer);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<ComposerError | null>(null);
  const [sending, setSending] = useState(false);
  const [budget, setBudget] = useState<{ line: string } | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | number | null>(null);
  const mounted = useRef(false);

  const provider = composer.captcha.provider;
  const noteOnly = draft.noteOnly;
  const needCaptcha = provider !== 'none' && composer.captcha.siteKey !== null;

  const arm = (): void => {
    if (mounted.current || !needCaptcha) return;
    mounted.current = true;
    void loadCaptchaScript(provider)
      .then(() => {
        const api = captchaApi(provider);
        if (api === null || widgetRef.current === null) {
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
      .catch(() => setError({ code: 'CAPTCHA_UNAVAILABLE', message: '' }));
  };

  useEffect(
    () => () => {
      const api = captchaApi(provider);
      if (widgetId.current !== null) api?.remove?.(widgetId.current);
      widgetId.current = null;
    },
    [provider],
  );

  // BOOK-33: a premise and a note are one text, not a «что это меняет» + a first sentence.
  const body = submissionBody(draft);
  const ready = body.length >= composer.minChars && (!needCaptcha || token !== null);

  const submit = async (): Promise<void> => {
    if (!viewer.signedIn) return;
    if (needCaptcha && token === null) {
      setError({ code: 'CAPTCHA_FAILED', message: 'проверка не пройдена — попробуйте ещё раз' });
      return;
    }
    if (body.length < composer.minChars) {
      setError({ code: 'INVALID', message: `замечание короче ${composer.minChars} символов` });
      return;
    }
    setSending(true);
    try {
      // The revision the paragraph was rendered from (BOOK-33): a mismatch is exactly what
      // STALE_ANCHOR reports, and the re-anchored draft carries the fresh one.
      const response = await postAnchoredComment(
        anchoredPayload(draft, {
          body,
          captchaToken: token ?? '',
          ...(noteOnly || draft.blockId === null ? {} : { proposedText: draft.proposed }),
          ...(noteOnly || draft.blockId === null || draft.kind === null ? {} : { interventionKind: draft.kind }),
        }),
      );
      setBudget({ line: budgetLine(response.remaining) });
      setError(null);
      onPosted(response.comment.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError({
          code: caught.code,
          message: caught.message,
          ...(caught.retryAfterMs === undefined ? {} : { retryAfterMs: caught.retryAfterMs }),
          ...(caught.resetAt === undefined ? {} : { resetAt: caught.resetAt }),
        });
        if (caught.code === 'CAPTCHA_FAILED') setToken(null);
      } else {
        setError({ code: 'INVALID', message: 'сеть не ответила — попробуйте ещё раз' });
      }
    } finally {
      setSending(false);
    }
  };

  if (!viewer.signedIn) {
    return (
      <div className="seam-signin">
        <p>войдите через Яндекс, чтобы оставить замечание</p>
        <a className="seam-cta" href="/auth/yandex/start">
          войти через Яндекс →
        </a>
        <p className="fine">Читать можно без входа. Автор замечания виден другим читателям.</p>
      </div>
    );
  }

  return (
    <form
      className="seam-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <InterventionKinds
        kind={draft.kind}
        noteOnly={noteOnly}
        disabled={sending}
        onPick={(choice) => onChange({ ...draft, kind: choice.kind, noteOnly: choice.noteOnly, body: choice.noteOnly ? draft.body : draft.body })}
      />

      {noteOnly || draft.blockId === null ? null : (
        <>
          <label className="field-label" htmlFor={`seam-body-${entry.n}`}>
            что это меняет
          </label>
          <input
            id={`seam-body-${entry.n}`}
            className="seam-input"
            type="text"
            value={draft.body}
            maxLength={composer.maxChars}
            placeholder="одна строка: что станет иначе"
            onChange={(event) => onChange({ ...draft, body: event.target.value })}
            disabled={sending}
          />
          <p className="seam-hint">
            если не заполнить — в дело пойдёт первое предложение · {counterLabel(draft.body.length, composer.maxChars)}
          </p>
        </>
      )}

      <label className="field-label" htmlFor={`seam-text-${entry.n}`}>
        {wordingLabel(draft)}
      </label>
      <textarea
        id={`seam-text-${entry.n}`}
        className="seam-text"
        value={draft.proposed}
        maxLength={limits.edit}
        rows={noteOnly ? 4 : 6}
        placeholder={
          draft.blockId === null
            ? 'что здесь происходит: событие, документ, поворот'
            : noteOnly
              ? 'что в тексте не читается: повтор, сбой, деталь, которой не веришь'
              : 'как это звучит в книге'
        }
        onFocus={arm}
        onChange={(event) => onChange({ ...draft, proposed: event.target.value })}
        disabled={sending}
      />
      <p className="seam-hint">{counterLabel(draft.proposed.length, limits.edit)}</p>

      <div className="seam-captcha" ref={widgetRef} data-armed={needCaptcha ? 'true' : 'false'}>
        {needCaptcha ? (
          <>
            <span className="seam-captcha-box" aria-hidden="true" />
            <span className="seam-captcha-label">проверка · {provider}</span>
            <span className="seam-captcha-state">{token === null ? 'без заданий' : 'пройдена'}</span>
          </>
        ) : (
          <span className="seam-captcha-label">проверка недоступна — форма закроется</span>
        )}
      </div>

      {error === null ? null : (
        <p className="seam-error" role="alert">
          {errorCopy(error).line}
          {errorCopy(error).detail === null ? null : <span className="seam-detail"> · {errorCopy(error).detail}</span>}
          {error.code === 'STALE_ANCHOR' ? (
            <button type="button" className="seam-inline-action" onClick={() => onReanchor?.(draft)}>
              привязать заново
            </button>
          ) : null}
          {error.code === 'EDIT_DAILY_LIMIT' ? (
            <button
              type="button"
              className="seam-inline-action"
              onClick={() => {
                // The day's edit is spent, not the reader's thought: the same text goes as a
                // note — no kind, no wording — instead of being lost.
                onChange({ ...draft, noteOnly: true, kind: null });
                setError(null);
              }}
            >
              оставить только замечание
            </button>
          ) : null}
        </p>
      )}

      <button className="seam-submit" type="submit" disabled={sending || !ready}>
        {sending ? 'передаётся' : submitLabel(draft)}
      </button>
      <p className="fine seam-licence">
        передаёте книге неисключительную лицензию на принятый вариант ·{' '}
        <a className="seam-link" href="/rules">
          правила →
        </a>
      </p>
      {budget === null ? null : <p className="seam-hint">{budget.line}</p>}
    </form>
  );
}
