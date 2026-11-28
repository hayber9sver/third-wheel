import { describe, expect, it } from 'vitest';
import {
  isMacPlatform,
  isPrimaryShortcut,
  listClickMode,
  shortcutLabel,
  undoRedoLabels,
  undoRedoShortcut,
} from './shortcuts.js';

const keys = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe('shortcuts', () => {
  it('detects macOS from process.platform or a user agent', () => {
    expect(isMacPlatform('darwin')).toBe(true);
    expect(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
    expect(isMacPlatform('win32')).toBe(false);
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
  });

  it('uses Cmd on Mac and Ctrl on Windows', () => {
    expect(isPrimaryShortcut({ ...keys, metaKey: true, key: 'o' }, 'o', true)).toBe(true);
    expect(isPrimaryShortcut({ ...keys, ctrlKey: true, key: 'o' }, 'o', true)).toBe(false);
    expect(isPrimaryShortcut({ ...keys, ctrlKey: true, key: 'O' }, 'o', false)).toBe(true);
    expect(isPrimaryShortcut({ ...keys, metaKey: true, key: 'o' }, 'o', false)).toBe(false);
    expect(
      isPrimaryShortcut({ ...keys, ctrlKey: true, shiftKey: true, key: 'o' }, 'o', false),
    ).toBe(false);
  });

  it('labels shortcuts per platform', () => {
    expect(shortcutLabel('o', true)).toBe('⌘O');
    expect(shortcutLabel('o', false)).toBe('Ctrl+O');
  });

  it('list clicks: Shift = range, anything else = add/remove', () => {
    expect(listClickMode(keys)).toBe('toggle');
    expect(listClickMode({ ...keys, shiftKey: true })).toBe('range');
    expect(listClickMode({ ...keys, metaKey: true })).toBe('toggle');
    expect(listClickMode({ ...keys, ctrlKey: true })).toBe('toggle');
  });

  it('undo / redo keys per platform', () => {
    const k = (mods: Partial<typeof keys>, key: string) => ({ ...keys, ...mods, key });
    expect(undoRedoShortcut(k({ metaKey: true }, 'z'), true)).toBe('undo');
    expect(undoRedoShortcut(k({ metaKey: true, shiftKey: true }, 'Z'), true)).toBe('redo');
    expect(undoRedoShortcut(k({ metaKey: true }, 'y'), true)).toBeUndefined();
    expect(undoRedoShortcut(k({ ctrlKey: true }, 'z'), true)).toBeUndefined();
    expect(undoRedoShortcut(k({ ctrlKey: true }, 'z'), false)).toBe('undo');
    expect(undoRedoShortcut(k({ ctrlKey: true }, 'y'), false)).toBe('redo');
    expect(undoRedoShortcut(k({ ctrlKey: true, shiftKey: true }, 'Z'), false)).toBe('redo');
    expect(undoRedoShortcut(k({ ctrlKey: true, altKey: true }, 'z'), false)).toBeUndefined();
    expect(undoRedoShortcut(k({}, 'z'), false)).toBeUndefined();
    expect(undoRedoLabels(true)).toEqual({ undo: '⌘Z', redo: '⇧⌘Z' });
    expect(undoRedoLabels(false)).toEqual({ undo: 'Ctrl+Z', redo: 'Ctrl+Y' });
  });
});
