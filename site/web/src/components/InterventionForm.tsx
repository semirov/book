import type { CatalogEntry, CommentDto, ComposerInfo, ViewerDto } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { ApiError, postAnchoredComment, reviseComment } from '../api.ts';
import { track } from '../lib/analytics.ts';
import { budgetLine, counterLabel, draftLimits, errorCopy, type ComposerError } from '../lib/composer.ts';
import { anchoredPayload, submissionBody, submitLabel, type SeamDraft } from '../lib/draft.ts';
import {
  NOTE_ACTION_LABEL,
  NOTE_BUDGET_LINE,
  NOTE_FATE_LINE,
  wordingLabel,
  wordingPlaceholder,
} from '../lib/kindChoices.ts';
import { revisePayload, REVISE_BUDGET_LINE, REVISE_LABEL } from '../lib/revise.ts';
import { SUBMIT_LINE } from '../lib/terms.ts';
import { InterventionKinds } from './InterventionKinds.tsx';

/**
 * BOOK-DOC-34 §2.3 — the form, grown inside the seam.
 *
 * Field order is the book's own logic: what the world-fact is → what it changes → how it
 * reads. BOOK-64: there is no challenge field, no widget and no token — the form submits
 * when the reader is signed in and the fields are valid, and the server holds the gate
 * (identity plus the comment and edit rate limits). Errors are printed in place — never a
 * toast — and the receipt is the caller's: a refused draft keeps every character, and a
 * stale anchor offers the re-anchoring path instead of silently moving the filing.
 *
 * BOOK-57: the note is not a fifth kind. It is a quiet action under the submit, and while it
 * is open the four-kind grid, «что это меняет» and the kind's wording field are gone: a note
 * is one field, it sends no kind and no wording, and it spends no edit of the day.
 *
 * BOOK-158: a draft that names a refused filing (`revisesId`) is a **revision**, not a new
 * filing. The form sends the reader's edited words to `POST /api/comments/:id/revise` — the
 * anchor is not sent at all, because the server keeps the row's own place — and the answer is
 * the same row reopened, which is what the caller's `onPosted` puts back on the page. Nothing
 * about the retry is hidden from the reader: the form states where the day's edit is spent.
 */
export type FormProps = {
  entry: CatalogEntry;
  draft: SeamDraft;
  composer: ComposerInfo;
  viewer: ViewerDto;
  onChange: (draft: SeamDraft) => void;
  /** BOOK-111: the posted DTO — the page shows the row from it, with no reload. */
  onPosted: (comment: CommentDto) => void;
  onReanchor?: (draft: SeamDraft) => void;
  /**
   * BOOK-111: a DUPLICATE refusal names the filing already sent; this opens it. The origin is
   * the refused form's own action, so closing the panel returns focus there.
   */
  onOpenDuplicate?: (id: string, origin: HTMLElement) => void;
  /**
   * BOOK-111: a refusal the strip holds while this form is unmounted. A panel opened from the
   * form's own refusal collapses the strip, so the form is rebuilt when the panel closes; the
   * refusal is the strip's fact and comes back with it (BOOK-63: a refusal spends nothing).
   */
  initialError?: ComposerError | null;
  /** Every set or clear of the refusal reaches the strip, so a remount prints the same line. */
  onRefused?: (error: ComposerError | null) => void;
};

export function InterventionForm({
  entry,
  draft,
  composer,
  viewer,
  onChange,
  onPosted,
  onReanchor,
  onOpenDuplicate,
  initialError = null,
  onRefused,
}: FormProps) {
  const limits = draftLimits(composer);
  const [error, setError] = useState<ComposerError | null>(initialError);
  const [sending, setSending] = useState(false);
  const [budget, setBudget] = useState<{ line: string } | null>(null);

  const noteOnly = draft.noteOnly;
  /** BOOK-158: the form is correcting a refused filing, not making a new one. */
  const revise = draft.revisesId !== null;

  /**
   * BOOK-63: `form_open` is the form the reader sees, once per mount. It carries nothing —
   * no chapter, no sentence, nothing they typed.
   */
  const announced = useRef(false);
  useEffect(() => {
    if (!viewer.signedIn || announced.current) return;
    announced.current = true;
    track('form_open', {});
  }, [viewer.signedIn]);

  // BOOK-33: a premise and a note are one text, not a «что это меняет» + a first sentence.
  const body = submissionBody(draft);
  const ready = body.length >= composer.minChars;
  // BOOK-57: the field's question follows the kind; a note asks its own.
  const field = { noteOnly, blockId: draft.blockId, kind: draft.kind };

  /**
   * The note path opens with an event and closes without one: opening is the act. Only
   * `noteOnly` changes: the draft is the reader's, so the intervention line they typed and
   * the kind they picked both survive the switch (the note payload ignores `body` and sends
   * no kind, and the field is hidden while the note is open, so nothing leaks).
   */
  const toggleNote = (): void => {
    if (noteOnly) {
      onChange({ ...draft, noteOnly: false });
      return;
    }
    onChange({ ...draft, noteOnly: true });
    track('kind_pick', { kind: 'note' });
  };

  /**
   * BOOK-111: the refusal is the strip's fact as well as this form's — a panel that opens from
   * it unmounts the form, and the strip hands the same line back when the panel closes.
   */
  const refuse = (next: ComposerError | null): void => {
    setError(next);
    onRefused?.(next);
  };

  const submit = async (): Promise<void> => {
    if (!viewer.signedIn) return;
    if (body.length < composer.minChars) {
      refuse({ code: 'INVALID', message: `замечание короче ${composer.minChars} символов` });
      track('error_shown', { code: 'INVALID' });
      return;
    }
    setSending(true);
    try {
      // BOOK-158 — a draft opened by «исправить» revises that filing: the words travel, the
      // anchor does not (the server keeps the row's chapter, block, quote and revision). The
      // answer is the same id, so the page replaces the row instead of adding one.
      if (draft.revisesId !== null) {
        const revised = await reviseComment(draft.revisesId, revisePayload(draft));
        setBudget(null);
        refuse(null);
        // No `submit_*` here: the taxonomy names a filing being made, and a revision is the
        // same filing corrected — the receipt the strip prints is the act the reader sees.
        onPosted(revised.comment);
        return;
      }
      // The revision the paragraph was rendered from (BOOK-33): a mismatch is exactly what
      // STALE_ANCHOR reports, and the re-anchored draft carries the fresh one.
      const response = await postAnchoredComment(
        anchoredPayload(draft, {
          body,
          ...(noteOnly || draft.blockId === null ? {} : { proposedText: draft.proposed }),
          ...(noteOnly || draft.blockId === null || draft.kind === null ? {} : { interventionKind: draft.kind }),
        }),
      );
      setBudget({ line: budgetLine(response.remaining) });
      refuse(null);
      // BOOK-63: the two paths are distinct acts; the count of the day stays on the server.
      track(noteOnly || draft.blockId === null ? 'submit_note' : 'submit_intervention', {});
      onPosted(response.comment);
    } catch (caught) {
      if (caught instanceof ApiError) {
        refuse({
          code: caught.code,
          message: caught.message,
          ...(caught.retryAfterMs === undefined ? {} : { retryAfterMs: caught.retryAfterMs }),
          ...(caught.resetAt === undefined ? {} : { resetAt: caught.resetAt }),
          ...(caught.commentId === undefined ? {} : { commentId: caught.commentId }),
          ...(caught.reopenAt === undefined ? {} : { reopenAt: caught.reopenAt }),
        });
        // The refusal is the server's; only its code leaves the page.
        track('submit_refused', { code: caught.code });
      } else {
        refuse({ code: 'INVALID', message: 'сеть не ответила — попробуйте ещё раз' });
        track('error_shown', { code: 'INVALID' });
      }
    } finally {
      setSending(false);
    }
  };

  /** BOOK-111: the id a duplicate refusal names, if this refusal is one. */
  const duplicateId = error !== null && error.code === 'DUPLICATE' ? (error.commentId ?? null) : null;

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
      className="seam-form ym-hide-content"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {noteOnly ? null : (
        <InterventionKinds
          kind={draft.kind}
          disabled={sending}
          onPick={(kind) => {
            // BOOK-63: which row was picked — one of four words, never what the reader writes.
            track('kind_pick', { kind });
            onChange({ ...draft, kind, noteOnly: false });
          }}
        />
      )}

      {noteOnly || draft.blockId === null ? null : (
        <>
          <label className="field-label" htmlFor={`seam-body-${entry.n}`}>
            что это меняет
          </label>
          <input
            id={`seam-body-${entry.n}`}
            className="seam-input ym-disable-keys"
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

      {noteOnly ? <p className="seam-hint">{NOTE_FATE_LINE}</p> : null}

      <label className="field-label" htmlFor={`seam-text-${entry.n}`}>
        {wordingLabel(field)}
      </label>
      <textarea
        id={`seam-text-${entry.n}`}
        className="seam-text ym-disable-keys"
        value={draft.proposed}
        maxLength={limits.edit}
        rows={noteOnly ? 4 : 6}
        placeholder={wordingPlaceholder(field)}
        onChange={(event) => onChange({ ...draft, proposed: event.target.value })}
        disabled={sending}
      />
      <p className="seam-hint">{counterLabel(draft.proposed.length, limits.edit)}</p>
      {noteOnly ? <p className="seam-hint">{NOTE_BUDGET_LINE}</p> : null}

      {error === null ? null : (
        <p className="seam-error" role="alert">
          {errorCopy(error).line}
          {errorCopy(error).detail === null ? null : <span className="seam-detail"> · {errorCopy(error).detail}</span>}
          {error.code === 'STALE_ANCHOR' ? (
            <button type="button" className="seam-inline-action" onClick={() => onReanchor?.(draft)}>
              привязать заново
            </button>
          ) : null}
          {duplicateId === null || onOpenDuplicate === undefined ? null : (
            // BOOK-111: the 409 names the filing that already exists; the reader gets a way to
            // it instead of a second identical form. The button is the origin, so focus returns
            // (`data-door` lets the strip hand it back after the panel's collapse, since the
            // form is rebuilt when the strip's rows come back).
            <button
              type="button"
              className="seam-inline-action"
              data-door="duplicate"
              onClick={(event) => onOpenDuplicate(duplicateId, event.currentTarget)}
            >
              открыть отправленное
            </button>
          )}
          {error.code === 'EDIT_DAILY_LIMIT' ? (
            <button
              type="button"
              className="seam-inline-action"
              onClick={() => {
                // The day's edit is spent, not the reader's thought: the same text goes as a
                // note — no kind, no wording — instead of being lost. The label is the note
                // submit's own, so the recovery and the action cannot drift apart.
                onChange({ ...draft, noteOnly: true });
                refuse(null);
              }}
            >
              {submitLabel({ noteOnly: true, blockId: draft.blockId })}
            </button>
          ) : null}
        </p>
      )}

      <button className="seam-submit" type="submit" disabled={sending || !ready}>
        {sending ? (revise ? 'исправляется' : 'передаётся') : revise ? REVISE_LABEL : submitLabel(draft)}
      </button>
      <button
        type="button"
        className="note-action"
        aria-pressed={noteOnly}
        disabled={sending}
        onClick={toggleNote}
      >
        {NOTE_ACTION_LABEL}
      </button>
      {/* BOOK-158 — a revision says where the day's edit goes, before the reader sends it. */}
      {revise ? <p className="fine seam-revise">{REVISE_BUDGET_LINE}</p> : null}
      <p className="fine seam-licence">
        {SUBMIT_LINE} <a className="seam-link" href="/rules">правила →</a>
      </p>
      {budget === null ? null : <p className="seam-hint">{budget.line}</p>}
    </form>
  );
}
