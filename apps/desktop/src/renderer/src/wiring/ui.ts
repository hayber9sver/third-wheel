/**
 * Small helpers every window module uses: elements by id, settings kept in localStorage.
 */
import type { ThemeMode } from '../../../shared/theme.js';

export const THEME_STORAGE_KEY = 'third-wheel.theme';
export const NAV_STYLE_STORAGE_KEY = 'third-wheel.navigation-style';
export const ORBIT_STYLE_STORAGE_KEY = 'third-wheel.orbit-style';
export const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

export function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
}

// localStorage may be unavailable (or throw); settings then just don't persist.
export function loadSetting<T>(key: string, isValid: (v: unknown) => v is T, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return isValid(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted.
  }
}
