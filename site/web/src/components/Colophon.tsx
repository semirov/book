import { TOTAL_CHAPTERS, type FrontDto, type StateSnapshot } from '@book/shared';
import { useEffect, useState } from 'react';

import { formatDate, formatNumber } from '../lib/format.ts';
import { applyTheme, currentTheme, type Theme } from '../lib/theme.ts';

const clock = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Europe/Moscow',
});

/**
 * The imprint line (`imprint.copyright`) lives here: the cover no longer carries «©»
 * (BOOK-DOC-5 §2), and «Авторы» keeps its own copy of it.
 */
export function Colophon({ state, imprint }: { state: StateSnapshot; imprint: FrontDto['imprint'] }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const toggle = (): void => {
    const next: Theme = theme === 'night' ? 'day' : 'night';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <footer className="page sheet colophon" id="colo">
      <div className="row">
        <span>
          книга · {state.chapters.count} / {TOTAL_CHAPTERS}
        </span>
        <span className="mono">{clock.format(now)}</span>
      </div>
      <div className="row">
        <span>печатается по ходу письма</span>
        <span className="mono">{formatNumber(state.chapters.totalChars)} зн.</span>
      </div>
      <div className="row">
        <span>
          {imprint.copyright} · издание · {formatDate(now.toISOString())} ·{' '}
          <a href="/privacy">приватность</a> · <a href="/rules">правила</a>
        </span>
        <button
          className="theme"
          type="button"
          onClick={toggle}
          aria-pressed={theme === 'night'}
          aria-label={theme === 'night' ? 'включить дневной бланк' : 'включить ночную смену'}
        >
          <span className="switch" aria-hidden="true" />
          {theme === 'night' ? 'дневной бланк' : 'ночная смена'}
        </button>
      </div>
    </footer>
  );
}
