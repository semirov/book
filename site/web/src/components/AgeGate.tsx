import { useState } from 'react';

import {
  AGE_GATE_FORWARD,
  AGE_GATE_LEAVE,
  AGE_GATE_LINE,
  AGE_LABEL,
} from '../lib/age.ts';

/**
 * The gate before the prose (BOOK-225).
 *
 * It is a **page**, not a layer: the same column, the same register as the book, and it stands
 * where the chapters would — so the answer is a state of the page the reader is on, one screen
 * at 390 px wide, and not a modal over text they have already been given. Nothing behind it
 * scrolls to prose: while it stands, the chapter flow is not mounted at all and the prose is
 * not requested (`App` asks for it after the answer, never before).
 *
 * Three facts and two doors, in the book's voice: the rating as a mark, the title as the book's
 * own (so the reader knows which book asks), one honest sentence about the inside, and the
 * choice as words — «мне есть 18 — читать» is an act, «мне нет 18 — уйти» is a real link out.
 * No paint, no badge, no legal paragraph, no explanation of the interface, and no moral after
 * the door: the reader who comes through is handed the book and nothing else.
 *
 * The sentence is deliberately short: harm inside the story is the genre, so the gate names
 * what is there (violence, blood, adult themes) and stops. It is the same fact the footer's row
 * and `/rules` print, from one module (`lib/age.ts`).
 *
 * While the answer is in flight the button is disabled — a second click cannot post twice — and
 * a refusal leaves the gate exactly as it was: the words claim nothing, and the reader may try
 * again. On success the parent unmounts this page and mounts the chapters.
 */
export function AgeGate({
  title,
  onAccept,
}: {
  /**
   * The book's own title, from `front.title`: the reader must know which book asks. `null` is a
   * book whose first sheet is missing or malformed — the gate then prints the rating and the
   * sentence and no invented name, exactly as the running head does.
   */
  title: string | null;
  /** `POST /api/age`; `true` means the acknowledgement was written and the page may move on. */
  onAccept: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const accept = (): void => {
    if (busy) return;
    setBusy(true);
    void onAccept().then((accepted) => {
      // A refusal is not an answer: the page stays as it was, and the door can be tried again.
      if (!accepted) setBusy(false);
    });
  };

  return (
    <main className="page gate">
      <p className="kicker gate-kicker">{AGE_LABEL}</p>
      {/* A book without a name prints none — no empty heading, no invented title. */}
      {title === null ? null : <p className="title gate-title">{title}</p>}
      <p className="gate-line">{AGE_GATE_LINE}</p>
      <p className="gate-doors">
        <button type="button" className="gate-go" onClick={accept} disabled={busy}>
          {AGE_GATE_FORWARD}
        </button>
        <a className="gate-leave" href="about:blank" rel="nofollow">
          {AGE_GATE_LEAVE}
        </a>
      </p>
    </main>
  );
}
