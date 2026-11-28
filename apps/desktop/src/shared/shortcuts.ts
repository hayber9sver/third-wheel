/** Platform-aware shortcuts: Cmd on macOS, Ctrl on Windows (and elsewhere). */

export interface ModifierState {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** True when running on macOS (pass `navigator.userAgent` or `process.platform`). */
export function isMacPlatform(platformOrUserAgent: string): boolean {
  return platformOrUserAgent === 'darwin' || /Mac/.test(platformOrUserAgent);
}

/** Cmd+`key` on Mac, Ctrl+`key` elsewhere — and no other modifier. */
export function isPrimaryShortcut(
  e: ModifierState & { readonly key: string },
  key: string,
  isMac: boolean,
): boolean {
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === key.toLowerCase();
}

/**
 * Undo / redo keys: Mac Cmd+Z / Cmd+Shift+Z; Windows Ctrl+Z / Ctrl+Y (also Ctrl+Shift+Z).
 */
export function undoRedoShortcut(
  e: ModifierState & { readonly key: string },
  isMac: boolean,
): 'undo' | 'redo' | undefined {
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey) return undefined;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !isMac && !e.shiftKey) return 'redo';
  return undefined;
}

/** Tooltip labels for undo / redo: `⌘Z` / `⇧⌘Z`, `Ctrl+Z` / `Ctrl+Y`. */
export function undoRedoLabels(isMac: boolean): { undo: string; redo: string } {
  return isMac ? { undo: '⌘Z', redo: '⇧⌘Z' } : { undo: 'Ctrl+Z', redo: 'Ctrl+Y' };
}

/** Label for tooltips, e.g. `⌘O` / `Ctrl+O`. */
export function shortcutLabel(key: string, isMac: boolean): string {
  return isMac ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/**
 * The OS dictation key (no in-app voice input): it types into any text box.
 * macOS: press the Globe / Fn key twice (System Settings → Keyboard → Dictation); Windows: Win+H.
 */
export function dictationLabel(isMac: boolean): string {
  return isMac ? 'Fn Fn' : 'Win+H';
}

/**
 * What a click on a body-list name does (matches the viewport): plain (also Cmd/Ctrl) =
 * add or remove that row, Shift = add the range from the last clicked row.
 */
export type ListClickMode = 'toggle' | 'range';

export function listClickMode(e: ModifierState): ListClickMode {
  return e.shiftKey ? 'range' : 'toggle';
}
