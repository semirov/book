/**
 * «книга · хроника» — one page, two ways of reading it (ARCHITECTURE §11.10).
 *
 * The toggle lives in the page, not in a route: the same URL, the same application, and the
 * chronicle is the same book with its history in front of it.
 */
export type BookView = 'book' | 'chronicle';

export function ViewSwitch({ view, onChange }: { view: BookView; onChange: (view: BookView) => void }) {
  return (
    <nav className="views page sheet" aria-label="как читать">
      <button
        type="button"
        className={`views-btn${view === 'book' ? ' is-on' : ''}`}
        aria-pressed={view === 'book'}
        onClick={() => onChange('book')}
      >
        книга
      </button>
      <button
        type="button"
        className={`views-btn${view === 'chronicle' ? ' is-on' : ''}`}
        aria-pressed={view === 'chronicle'}
        onClick={() => onChange('chronicle')}
      >
        хроника
      </button>
    </nav>
  );
}
