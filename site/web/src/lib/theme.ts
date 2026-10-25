/** Theme follows the system until the reader says otherwise (DESIGN §3.1). */

export type Theme = 'day' | 'night';

const STORAGE_KEY = 'book.theme';

export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'day' || value === 'night' ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'night' ? '#0F1113' : '#E9E8E2');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode: the theme simply does not persist */
  }
}

export function currentTheme(): Theme {
  const attribute = document.documentElement.getAttribute('data-theme');
  return attribute === 'night' ? 'night' : 'day';
}
