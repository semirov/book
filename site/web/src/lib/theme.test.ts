import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, currentTheme, readStoredTheme, systemTheme } from './theme.ts';

type Store = { value: string | null; set: string[] };

function stubThemeEnvironment(options: { stored?: string | null; dark?: boolean; attribute?: string | null }) {
  const store: Store = { value: options.stored ?? null, set: [] };
  const attributes: Record<string, string> = {};
  if (options.attribute) attributes['data-theme'] = options.attribute;
  const themeMeta = { setAttribute: vi.fn() };

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'book.theme' ? store.value : null),
    setItem: (key: string, value: string) => {
      if (key === 'book.theme') {
        store.value = value;
        store.set.push(value);
      }
    },
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: options.dark ?? false }) });
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      getAttribute: (name: string) => attributes[name] ?? null,
    },
    querySelector: () => themeMeta,
  });
  return { store, attributes, themeMeta };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readStoredTheme', () => {
  it('reads a stored choice', () => {
    stubThemeEnvironment({ stored: 'night' });
    expect(readStoredTheme()).toBe('night');
  });

  it('ignores anything that is not a theme', () => {
    stubThemeEnvironment({ stored: 'sepia' });
    expect(readStoredTheme()).toBeNull();
  });

  it('survives a blocked storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readStoredTheme()).toBeNull();
  });
});

describe('systemTheme', () => {
  it('follows prefers-color-scheme', () => {
    stubThemeEnvironment({ dark: true });
    expect(systemTheme()).toBe('night');
    stubThemeEnvironment({ dark: false });
    expect(systemTheme()).toBe('day');
  });
});

describe('applyTheme', () => {
  it('sets the attribute, the theme-color and remembers the choice', () => {
    const environment = stubThemeEnvironment({});
    applyTheme('night');
    expect(environment.attributes['data-theme']).toBe('night');
    expect(environment.themeMeta.setAttribute).toHaveBeenCalledWith('content', '#0B0C0D');
    expect(environment.store.set).toEqual(['night']);

    applyTheme('day');
    expect(environment.attributes['data-theme']).toBe('day');
    expect(environment.themeMeta.setAttribute).toHaveBeenLastCalledWith('content', '#CFD3D2');
  });
});

describe('currentTheme', () => {
  it('reads the attribute set before first paint', () => {
    stubThemeEnvironment({ attribute: 'night' });
    expect(currentTheme()).toBe('night');
    stubThemeEnvironment({});
    expect(currentTheme()).toBe('day');
  });
});
